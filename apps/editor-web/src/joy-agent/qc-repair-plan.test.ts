import { describe, expect, it } from 'vitest';
import { applyAudioCommand, applyTransaction } from '@joy-media/commands';
import type { AudioState } from '@joy-media/commands';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import { emptySpikeProject, makeVideoClip, withClips } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import type { TimelineQcTextBox } from '../media-observation/qc-sampler.js';
import {
  insideSafeArea,
  planQcRepairs,
  type QcRepairFinding,
  type QcRepairInput,
} from './qc-repair-plan.js';

const S = 1_000_000;

function timeline(): SpikeProject {
  const base = emptySpikeProject({
    trackCount: 2,
    durationUs: 12 * S,
    frameRate: { num: 30, den: 1 },
  });
  return withClips(
    withClips(base, 'track-0', [
      makeVideoClip('a', 0, 4 * S, { sourceInUs: 0 }),
      makeVideoClip('b', 4 * S, 4 * S, { sourceInUs: 0 }),
      makeVideoClip('c', 8 * S, 4 * S, { sourceInUs: 0 }),
    ]),
    'track-1',
    [],
  );
}

const AUDIO: AudioState = {
  clips: {},
  buses: [{ id: 'master', name: 'Master', gain: 1, pan: 0, mute: false, solo: false, inputs: [] }],
  effects: [],
};

const TITLE_ID = 'qc-title';

function document(): JoyProjectV1 {
  return {
    ...INITIAL_EDITOR_PROJECT,
    visualObjects: {
      ...INITIAL_EDITOR_PROJECT.visualObjects,
      [TITLE_ID]: {
        id: TITLE_ID,
        kind: 'text',
        text: 'Hello',
        transform: {
          x: 10,
          y: 900,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
      },
    },
  };
}

const TITLE_BOX: TimelineQcTextBox = {
  id: TITLE_ID,
  kind: 'title',
  startUs: 5 * S,
  endUs: 7 * S,
  x: 10 / 1080,
  y: 900 / 1920,
  width: 400 / 1080,
  height: 100 / 1920,
  textColor: { r: 255, g: 255, b: 255, a: 255 },
};

function input(
  findings: readonly QcRepairFinding[],
  extra: Partial<QcRepairInput> = {},
): QcRepairInput {
  return {
    findings,
    timeline: timeline(),
    document: document(),
    audio: AUDIO,
    textBoxes: [TITLE_BOX],
    planId: 'plan-test',
    createdAt: '2026-11-15T00:00:00.000Z',
    ...extra,
  };
}

function clipsOf(project: SpikeProject, trackId = 'track-0') {
  const track = project.compositions[project.rootCompositionId]!.tracks.find(
    (t) => t.id === trackId,
  )!;
  return [...track.clips]
    .sort((l, r) => l.startUs - r.startUs)
    .map((clip) => ({
      id: clip.id,
      startUs: clip.startUs,
      durationUs: clip.durationUs,
      sourceInUs: clip.kind === 'video' ? clip.sourceInUs : undefined,
    }));
}

function applied(project: SpikeProject, plan: ReturnType<typeof planQcRepairs>): SpikeProject {
  return applyTransaction(project, { label: 'test', commands: [...plan.timelineCommands] }).project;
}

describe('QC repair plan: black and frozen', () => {
  it('cuts a black head and ripples the later shots back', () => {
    const plan = planQcRepairs(
      input([{ id: 'f1', type: 'black', startUs: 0, endUs: 1 * S + 40_000 }]),
    );
    expect(plan.notRepairable).toEqual([]);
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]).toMatchObject({ kind: 'cut', clipId: 'a', startUs: 0 });
    const after = clipsOf(applied(timeline(), plan));
    expect(after).toEqual([
      { id: 'a', startUs: 0, durationUs: 2_960_000, sourceInUs: 1_040_000 },
      { id: 'b', startUs: 2_960_000, durationUs: 4 * S, sourceInUs: 0 },
      { id: 'c', startUs: 6_960_000, durationUs: 4 * S, sourceInUs: 0 },
    ]);
    expect(plan.repairedTypes).toEqual(['black']);
    // The join at 0 is re-checked, not the whole cut.
    expect(plan.changedRanges).toEqual([{ startUs: 0, endUs: 500_000 }]);
  });

  it('snaps a black tail to the shot end and trims it', () => {
    const plan = planQcRepairs(
      input([{ id: 'f1', type: 'black', startUs: 11 * S, endUs: 12 * S - 30_000 }]),
    );
    expect(plan.edits[0]).toMatchObject({
      kind: 'cut',
      clipId: 'c',
      startUs: 11 * S,
      endUs: 12 * S,
    });
    expect(clipsOf(applied(timeline(), plan)).at(-1)).toMatchObject({ id: 'c', durationUs: 3 * S });
  });

  it('refuses black in the middle of a shot', () => {
    const plan = planQcRepairs(input([{ id: 'f1', type: 'black', startUs: 5 * S, endUs: 6 * S }]));
    expect(plan.edits).toEqual([]);
    expect(plan.notRepairable).toEqual([
      expect.objectContaining({
        findingId: 'f1',
        type: 'black',
        reason: expect.stringMatching(/middle/),
      }),
    ]);
  });

  it('cuts a frozen run out of the middle of a shot with two splits and a ripple', () => {
    const plan = planQcRepairs(input([{ id: 'f1', type: 'frozen', startUs: 5 * S, endUs: 6 * S }]));
    expect(plan.notRepairable).toEqual([]);
    const after = clipsOf(applied(timeline(), plan));
    expect(after).toEqual([
      { id: 'a', startUs: 0, durationUs: 4 * S, sourceInUs: 0 },
      { id: 'b', startUs: 4 * S, durationUs: 1 * S, sourceInUs: 0 },
      { id: 'b-qc-rest', startUs: 5 * S, durationUs: 2 * S, sourceInUs: 2 * S },
      { id: 'c', startUs: 7 * S, durationUs: 4 * S, sourceInUs: 0 },
    ]);
  });

  it('applies two cuts latest first, so the earlier times stay true', () => {
    const plan = planQcRepairs(
      input([
        { id: 'f1', type: 'black', startUs: 0, endUs: 1 * S },
        { id: 'f2', type: 'frozen', startUs: 9 * S, endUs: 10 * S },
      ]),
    );
    expect(plan.edits.map((edit) => edit.kind)).toEqual(['cut', 'cut']);
    const after = clipsOf(applied(timeline(), plan));
    expect(after.map((clip) => [clip.id, clip.startUs, clip.durationUs])).toEqual([
      ['a', 0, 3 * S],
      ['b', 3 * S, 4 * S],
      ['c', 7 * S, 1 * S],
      ['c-qc-rest', 8 * S, 2 * S],
    ]);
    expect(plan.mapTimeUs(10 * S)).toBe(8 * S);
    expect(plan.mapTimeUs(500_000)).toBe(0);
  });

  it('refuses a range that runs over two shots', () => {
    const plan = planQcRepairs(input([{ id: 'f1', type: 'frozen', startUs: 3 * S, endUs: 5 * S }]));
    expect(plan.edits).toEqual([]);
    expect(plan.notRepairable[0]?.reason).toMatch(/two shots/);
  });

  it('leaves titles and audio rows alone when it looks for the shot', () => {
    const plan = planQcRepairs(
      input([{ id: 'f1', type: 'black', startUs: 0, endUs: 1 * S }], {
        isPictureClip: (clip) => clip.id !== 'a',
      }),
    );
    expect(plan.notRepairable[0]?.reason).toMatch(/No shot/);
  });
});

describe('QC repair plan: loudness and clipping', () => {
  it('raises a quiet cut to the target with one master gain change', () => {
    const plan = planQcRepairs(
      input([
        {
          id: 'f1',
          type: 'loudness',
          startUs: 0,
          endUs: 12 * S,
          measured: { integratedLufs: -32, truePeakDbfs: -20 },
        },
      ]),
    );
    expect(plan.edits).toEqual([
      expect.objectContaining({ kind: 'gain', busId: 'master', changeDb: 18, fromGain: 1 }),
    ]);
    const gain = plan.audioCommands[0]!;
    const state = applyAudioCommand(AUDIO, gain).state;
    expect(state.buses[0]!.gain).toBeCloseTo(10 ** (18 / 20), 3);
    expect(plan.changedRanges).toEqual([{ startUs: 0, endUs: 12 * S }]);
  });

  it('holds the raise under the true-peak limit', () => {
    const plan = planQcRepairs(
      input([
        {
          id: 'f1',
          type: 'loudness',
          startUs: 0,
          endUs: 12 * S,
          measured: { integratedLufs: -28, truePeakDbfs: -6 },
        },
      ]),
    );
    expect(plan.edits[0]).toMatchObject({ kind: 'gain', changeDb: 5 });
  });

  it('lowers the level for clipping', () => {
    const plan = planQcRepairs(
      input([{ id: 'f1', type: 'clipping', startUs: 0, endUs: 12 * S, measured: { peakDb: 0.5 } }]),
    );
    expect(plan.edits[0]).toMatchObject({ kind: 'gain', changeDb: -1.5 });
  });

  it('says so when the peaks leave no room to reach a good level', () => {
    const plan = planQcRepairs(
      input([
        {
          id: 'f1',
          type: 'loudness',
          startUs: 0,
          endUs: 12 * S,
          measured: { integratedLufs: -30, truePeakDbfs: -2 },
        },
      ]),
    );
    expect(plan.edits).toEqual([]);
    expect(plan.notRepairable[0]?.reason).toMatch(/peaks/);
  });
});

describe('QC repair plan: titles and the rest', () => {
  it('moves a title inside the safe area by whole pixels', () => {
    const plan = planQcRepairs(
      input([{ id: 'f1', type: 'safe-area', startUs: 5 * S, endUs: 7 * S }]),
    );
    const edit = plan.edits[0]!;
    expect(edit).toMatchObject({ kind: 'move', objectId: TITLE_ID, dyPx: 0 });
    const dx = edit.kind === 'move' ? edit.dxPx : 0;
    expect(insideSafeArea({ ...TITLE_BOX, x: TITLE_BOX.x + dx / 1080 })).toBe(true);
    expect(plan.visualCommands).toEqual([
      {
        type: 'object.setTransformProperty',
        payload: { objectId: TITLE_ID, key: 'x', value: 10 + dx },
      },
    ]);
  });

  it('refuses to move a title that is animated', () => {
    const plan = planQcRepairs(
      input([{ id: 'f1', type: 'safe-area', startUs: 0, endUs: 1 * S }], {
        textBoxes: [{ ...TITLE_BOX, id: 'intro-title', startUs: 0, endUs: 1 * S }],
      }),
    );
    expect(plan.notRepairable[0]?.reason).toMatch(/moves over time/);
  });

  it('lists text legibility and the advice-only types as not repairable', () => {
    const plan = planQcRepairs(
      input([
        { id: 'f1', type: 'text-legibility', startUs: 5 * S, endUs: 7 * S },
        { id: 'f2', type: 'exposure', startUs: 0, endUs: 1 * S },
        { id: 'f3', type: 'scene-cut', startUs: 4 * S, endUs: 4 * S },
        { id: 'f4', type: 'something-new', startUs: 0, endUs: 1 * S },
      ]),
    );
    expect(plan.edits).toEqual([]);
    expect(plan.notRepairable.map((entry) => entry.findingId)).toEqual(['f1', 'f2', 'f3', 'f4']);
    expect(plan.notRepairable[0]!.reason).toMatch(/no text backing/);
    expect(plan.agentPlan.assumptions).toHaveLength(4);
    expect(plan.agentPlan.assumptions[0]).toMatch(/^Not repairable \(text-legibility, f1\)/);
  });

  it('builds one previewed plan in the shape of the existing plan card', () => {
    const plan = planQcRepairs(
      input([
        { id: 'f1', type: 'black', startUs: 0, endUs: 1 * S },
        {
          id: 'f2',
          type: 'loudness',
          startUs: 0,
          endUs: 12 * S,
          measured: { integratedLufs: -30 },
        },
        { id: 'f3', type: 'safe-area', startUs: 5 * S, endUs: 7 * S },
      ]),
    );
    expect(plan.agentPlan).toMatchObject({
      planVersion: 1,
      planId: 'plan-test',
      status: 'pending-approval',
      goal: 'Fix what the quality check found',
    });
    expect(plan.agentPlan.steps).toHaveLength(3);
    expect(plan.agentPlan.steps.every((step) => step.requiresConfirmation)).toBe(true);
    expect([...plan.repairedTypes].sort()).toEqual(['black', 'loudness', 'safe-area']);
  });

  it('is deterministic for the same input', () => {
    const findings: QcRepairFinding[] = [
      { id: 'f1', type: 'frozen', startUs: 5 * S, endUs: 6 * S },
      { id: 'f2', type: 'safe-area', startUs: 5 * S, endUs: 7 * S },
    ];
    const first = planQcRepairs(input(findings));
    const second = planQcRepairs(input(findings));
    expect(JSON.stringify(second.timelineCommands)).toBe(JSON.stringify(first.timelineCommands));
    expect(second.visualCommands).toEqual(first.visualCommands);
  });

  it('resolves title-occurrence box ids back to the underlying visual object', () => {
    const base = input([{ id: 'f1', type: 'safe-area', startUs: 5 * S, endUs: 7 * S }]);
    const box = base.textBoxes![0]!;
    const plan = planQcRepairs({
      ...base,
      textBoxes: [{ ...box, id: `title-occurrence:${box.id.length}:${box.id}:clip-1` }],
    });
    expect(plan.notRepairable).toEqual([]);
    expect(plan.repairedTypes).toEqual(['safe-area']);
    expect(plan.visualCommands).toHaveLength(1);
    expect(plan.visualCommands[0]).toMatchObject({
      type: 'object.setTransformProperty',
      payload: { objectId: box.id },
    });
  });
});
