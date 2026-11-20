import { describe, expect, it } from 'vitest';
import { EXPORT_PRESETS } from '../../../apps/editor-web/src/export-presets.ts';
import { REQUIRED_ATTENDED_CHECKS, validateAttendedReceipt } from './attended-receipt.ts';
import { TIMELINE_LOG_KEY, VISUAL_LOG_KEY } from './attended-fresh-process.ts';
import {
  ACTIVE_PROJECT_KEY,
  EXPECTED_AUDIO_SAMPLE_RATE,
  EXPORT_PRESET_FRAME_RATE,
  EXPORT_SEMANTICS_SCENARIO,
  SEMANTICS_EXPORT_FILE,
  audioBlockers,
  clipNamed,
  dissolveOf,
  durationBlockers,
  expectationFrom,
  frameCountBlockers,
  parseAstatsRms,
  placementOf,
  previewFileName,
  probeRateOf,
  runExportMediaSemantics,
  samplePlan,
  seekSecondsOf,
  semanticsNames,
  semanticsProbeFrom,
  streamLayoutBlockers,
  timelineFactsFrom,
  type FactClip,
  type SemanticsProbe,
  type TimelineFacts,
} from './attended-export-semantics.ts';
import {
  DRY_RUN_CANDIDATE,
  DryRunWorld,
  dryRunInput,
  runExportSemanticsDryRun,
  type DryRunFaults,
} from './attended-export-semantics-dry-run.ts';

const REQUIRED = REQUIRED_ATTENDED_CHECKS[EXPORT_SEMANTICS_SCENARIO];
const RUN_ID = 'dry-run-00000000-0000-4000-8000-000000000000';
const names = semanticsNames(RUN_ID);

async function dryRun(faults: DryRunFaults = {}) {
  return runExportSemanticsDryRun({ runId: RUN_ID, faults });
}

function statusOf(report: { readonly checks: readonly { name: string; status: string }[] }) {
  return Object.fromEntries(report.checks.map((check) => [check.name, check.status]));
}

function detailOf(
  report: { readonly checks: readonly { name: string; detail: string }[] },
  name: string,
): string {
  return report.checks.find((check) => check.name === name)?.detail ?? '';
}

describe('the dry run', () => {
  it('passes every check and writes a receipt that the receipt validator accepts', async () => {
    const { report, world } = await dryRun();
    expect(report.verdict).toBe('passed');
    expect(report.blockers).toEqual([]);
    expect(report.checks.map((check) => check.name)).toEqual(REQUIRED);
    expect(report.checks.every((check) => check.status === 'passed')).toBe(true);
    expect(report.receipt).toBeDefined();
    expect(
      validateAttendedReceipt(report.receipt, {
        scenarioId: EXPORT_SEMANTICS_SCENARIO,
        candidateSha: DRY_RUN_CANDIDATE,
      }),
    ).toEqual([]);
    expect(report.receipt?.artifacts.map((artifact) => artifact.name)).toEqual([
      previewFileName(19),
      previewFileName(56),
      previewFileName(135),
      previewFileName(83),
      SEMANTICS_EXPORT_FILE,
    ]);
    expect([...world.files.keys()]).toContain(SEMANTICS_EXPORT_FILE);
    expect(report.launches).toBe(1);
  });

  it('places the media through the page, then the Dissolve, then captures, then exports, then closes', async () => {
    const { world } = await dryRun();
    expect(world.events).toEqual([
      `seed C:\\dry-run\\profile C:\\dry-run\\library`,
      'launch 1',
      `create ${names.projectTitle}`,
      `import ${names.videoName} video/mp4`,
      `import ${names.stillName} image/png`,
      `fill ${names.stillLabel}`,
      `dissolve ${names.stillLabel}`,
      'close 40001',
    ]);
    expect(world.clips[1]?.startUs).toBe(3_000_000);
  });

  it('records what it measured', async () => {
    const { report } = await dryRun();
    expect(report.measurements.expectation).toEqual({
      width: 1920,
      height: 1080,
      frameRate: 30,
      durationUs: 6_000_000,
      frameCount: 180,
      preset: 'social-h264-aac',
    });
    expect(report.measurements.decodedFrames).toBe(180);
    expect(report.measurements.dissolve).toMatchObject({ frame: 83 });
    expect(detailOf(report, 'dissolve-checked')).toContain('gl:fade of 500000 µs');
    expect(detailOf(report, 'picture-matches-reference')).toContain('frames 19, 56, 135');
  });

  it('binds a receipt to a candidate it is given', async () => {
    const candidate = 'ded976c8b4fe10c0316e5071ece535ba181707e9';
    const { report } = await runExportSemanticsDryRun({ runId: RUN_ID, candidateSha: candidate });
    expect(
      validateAttendedReceipt(report.receipt, {
        scenarioId: EXPORT_SEMANTICS_SCENARIO,
        candidateSha: candidate,
      }),
    ).toEqual([]);
  });
});

describe('each check fails on its own fault', () => {
  it('export-completed: the export fails, and the measured checks are not run', async () => {
    const { report } = await dryRun({ exportFails: true });
    expect(report.verdict).toBe('failed');
    expect(report.receipt).toBeUndefined();
    expect(statusOf(report)).toMatchObject({
      'export-completed': 'failed',
      'stream-layout-matches-preset': 'not-run',
      'picture-matches-reference': 'not-run',
    });
    expect(detailOf(report, 'export-completed')).toContain('the render did not verify');
  });

  it('export-completed: an empty export fails', async () => {
    const { report } = await dryRun({ emptyExport: true });
    expect(statusOf(report)['export-completed']).toBe('failed');
    expect(detailOf(report, 'export-completed')).toBe('the export is empty');
  });

  it('export-completed: the still on another track stops the run before the export', async () => {
    const { report } = await dryRun({ stillOnOtherTrack: true });
    expect(statusOf(report)['export-completed']).toBe('failed');
    expect(detailOf(report, 'export-completed')).toContain('not on the clip');
  });

  it('export-completed: a profile on another library stops the run', async () => {
    const { report } = await dryRun({ libraryReported: 'C:\\Users\\owner\\joy-media-assets' });
    expect(statusOf(report)['export-completed']).toBe('failed');
    expect(detailOf(report, 'export-completed')).toContain('not C:\\dry-run\\library');
  });

  it('stream-layout-matches-preset: a wrong size fails it and nothing else', async () => {
    const { report } = await dryRun({ exportSize: { width: 1280, height: 720 } });
    expect(statusOf(report)).toMatchObject({
      'export-completed': 'passed',
      'stream-layout-matches-preset': 'failed',
      'duration-matches-timeline': 'passed',
      'frame-count-matches-timeline': 'passed',
      'audio-present': 'passed',
      'picture-matches-reference': 'passed',
      'dissolve-checked': 'passed',
    });
    expect(detailOf(report, 'stream-layout-matches-preset')).toContain('1280x720');
    expect(report.receipt).toBeUndefined();
  });

  it('stream-layout-matches-preset: mono audio fails it', async () => {
    const { report } = await dryRun({ audioChannels: 1 });
    expect(statusOf(report)['stream-layout-matches-preset']).toBe('failed');
    expect(detailOf(report, 'stream-layout-matches-preset')).toContain('1 channels, not 2');
  });

  it('duration-matches-timeline: a file a quarter second long fails it', async () => {
    const { report } = await dryRun({ durationOffsetSeconds: 0.25 });
    expect(statusOf(report)['duration-matches-timeline']).toBe('failed');
    expect(statusOf(report)['frame-count-matches-timeline']).toBe('passed');
  });

  it('frame-count-matches-timeline: one frame short fails it', async () => {
    const { report } = await dryRun({ frameCountOffset: -1 });
    expect(statusOf(report)['frame-count-matches-timeline']).toBe('failed');
    expect(detailOf(report, 'frame-count-matches-timeline')).toContain('179 frames, not');
  });

  it('audio-present: a silent right channel fails it', async () => {
    const { report } = await dryRun({ silentChannel: 2 });
    expect(statusOf(report)['audio-present']).toBe('failed');
    expect(detailOf(report, 'audio-present')).toContain('channel 2 is silent');
  });

  it('audio-present: no audio stream fails it and the stream layout', async () => {
    const { report } = await dryRun({ noAudioStream: true });
    expect(statusOf(report)).toMatchObject({
      'audio-present': 'failed',
      'stream-layout-matches-preset': 'failed',
    });
  });

  it('picture-matches-reference: a black Monitor at one frame fails it', async () => {
    const { report } = await dryRun({ previewBlackFirst: true });
    expect(statusOf(report)['picture-matches-reference']).toBe('failed');
    expect(detailOf(report, 'picture-matches-reference')).toContain(
      'frame 19: the reference frame is black',
    );
  });

  it('picture-matches-reference: a Monitor 1.5 s late fails it', async () => {
    const { report } = await dryRun({ previewLate: true });
    expect(statusOf(report)['picture-matches-reference']).toBe('failed');
  });

  it('picture-matches-reference and dissolve-checked: failed captures fail both, the rest still runs', async () => {
    const { report } = await dryRun({ previewFails: true });
    expect(statusOf(report)).toMatchObject({
      'export-completed': 'passed',
      'audio-present': 'passed',
      'picture-matches-reference': 'failed',
      'dissolve-checked': 'failed',
    });
    expect(detailOf(report, 'picture-matches-reference')).toContain(
      'the Monitor capture of frame 19 failed',
    );
  });

  it('dissolve-checked: a hard cut in the export fails it', async () => {
    const { report } = await dryRun({ hardCut: true });
    expect(statusOf(report)['dissolve-checked']).toBe('failed');
    expect(detailOf(report, 'dissolve-checked')).toContain('not clearly a blend');
  });

  it('dissolve-checked: no Dissolve on the timeline fails it, and the export is still measured', async () => {
    const { report } = await dryRun({ noDissolve: true });
    expect(statusOf(report)).toMatchObject({
      'dissolve-checked': 'failed',
      'export-completed': 'passed',
      'picture-matches-reference': 'passed',
    });
    expect(detailOf(report, 'dissolve-checked')).toContain('0 transitions between the clips');
  });

  it('dissolve-checked: another transition fails it', async () => {
    const { report } = await dryRun({ dissolveType: 'gl:wipeLeft' });
    expect(detailOf(report, 'dissolve-checked')).toContain('gl:wipeLeft, not the Dissolve');
  });
});

describe('the dry run compares two models, and each fault is measured', () => {
  it('the export is a different model of the picture, so the picture check sees a small, non-zero difference', async () => {
    const { report } = await dryRun();
    const picture = report.measurements.picture as Record<
      string,
      { meanDifference: number; ssim: number }
    >;
    for (const [frame, comparison] of Object.entries(picture)) {
      expect(comparison.meanDifference, frame).toBeGreaterThan(0);
      expect(comparison.meanDifference, frame).toBeLessThan(12);
      expect(comparison.ssim, frame).toBeLessThan(1);
      expect(comparison.ssim, frame).toBeGreaterThanOrEqual(0.9);
    }
    expect(report.measurements.probe).toMatchObject({
      video: [{ frameRate: 30 }],
    });
  });

  it('picture-matches-reference: an export moved 40 levels from the Monitor fails it on the mean difference', async () => {
    const { report } = await dryRun({ exportLevelShift: 40 });
    expect(statusOf(report)['picture-matches-reference']).toBe('failed');
    expect(detailOf(report, 'picture-matches-reference')).toContain('the mean difference');
    expect(report.receipt).toBeUndefined();
  });

  it('stream-layout-matches-preset: an export at 25 fps fails it and the composition check names the preset', async () => {
    const { report } = await dryRun({ exportFrameRate: 25 });
    expect(statusOf(report)['stream-layout-matches-preset']).toBe('failed');
    expect(detailOf(report, 'stream-layout-matches-preset')).toContain(
      "the video runs at 25 fps, not the composition's 30 fps",
    );
    expect(statusOf(report)['duration-matches-timeline']).toBe('passed');
  });

  it('dissolve-checked: a Dissolve that moves the still fails it, because the placement is read again after it', async () => {
    const { report } = await dryRun({ dissolveMovesStill: true });
    expect(statusOf(report)['dissolve-checked']).toBe('failed');
    expect(detailOf(report, 'dissolve-checked')).toContain('not where the clip ends');
    expect(detailOf(report, 'export-completed')).toContain('Export MP4 finished');
  });
});

describe('guards and blockers', () => {
  it('refuses before launch when the joy:// key is not the expected one', async () => {
    const { report, world } = await dryRun({ joyKey: 'f'.repeat(64) });
    expect(report.verdict).toBe('refused');
    expect(report.launches).toBe(0);
    expect(world.events).toEqual([]);
  });

  it('fails a run whose Downloads folder changed', async () => {
    const { report } = await dryRun({ downloadsChange: true });
    expect(report.verdict).toBe('failed');
    expect(report.blockers).toContain('the Downloads folder changed during the run');
    expect(report.checks.every((check) => check.status === 'passed')).toBe(true);
    expect(report.receipt).toBeUndefined();
  });

  it('fails a run whose app did not close', async () => {
    const { report } = await dryRun({ closeFails: true });
    expect(report.verdict).toBe('failed');
    expect(report.blockers.some((blocker) => blocker.includes('did not close'))).toBe(true);
  });

  it('will not start without an approved owner library count', async () => {
    await expect(
      runExportMediaSemantics(new DryRunWorld(), { ...dryRunInput(), approvedOwnerFiles: 0 }),
    ).rejects.toThrow('approved owner library count');
  });
});

function stores(timeline: unknown, visual?: unknown, projectId = 'p1') {
  const log = (payload: unknown) =>
    JSON.stringify({ projects: { [projectId]: { snapshots: [{ payload: {} }, { payload }] } } });
  return {
    [ACTIVE_PROJECT_KEY]: JSON.stringify({ projectId }),
    [TIMELINE_LOG_KEY]: log(timeline),
    [VISUAL_LOG_KEY]: visual === undefined ? null : log(visual),
  };
}

const TIMELINE = {
  rootCompositionId: 'root',
  compositions: {
    root: {
      width: 1920,
      height: 1080,
      frameRate: { num: 30000, den: 1001 },
      tracks: [
        {
          id: 'v1',
          kind: 'video',
          family: 'video',
          clips: [
            { id: 'c1', assetId: 'a1', startUs: 0, durationUs: 3_000_000, sourceInUs: 500_000 },
            { id: 'c2', assetId: 'a2', startUs: 3_000_400, durationUs: 2_000_000 },
          ],
        },
        {
          id: 'a1row',
          family: 'audio',
          clips: [{ id: 'c3', assetId: 'a1', startUs: 0, durationUs: 3_000_000 }],
        },
      ],
    },
  },
};
const VISUAL = {
  exportPreset: 'youtube-1080',
  assets: {
    a1: { id: 'a1', displayName: names.videoName },
    a2: { id: 'a2', displayName: names.stillName },
  },
  transitions: [
    { id: 't1', type: 'gl:fade', leftClipId: 'c1', rightClipId: 'c2', durationUs: 500_000 },
  ],
};

describe('timelineFactsFrom', () => {
  it('reads the newest snapshots of the open project', () => {
    const facts = timelineFactsFrom(stores(TIMELINE, VISUAL));
    expect(facts).toMatchObject({
      projectId: 'p1',
      width: 1920,
      height: 1080,
      frameRateFromProject: true,
      preset: 'youtube-1080',
    });
    expect(facts.frameRate).toBeCloseTo(29.97, 2);
    expect(
      facts.clips.map((clip) => [clip.id, clip.trackFamily, clip.displayName, clip.sourceInUs]),
    ).toEqual([
      ['c1', 'video', names.videoName, 500_000],
      ['c2', 'video', names.stillName, 0],
      ['c3', 'audio', names.videoName, 0],
    ]);
    expect(facts.transitions).toEqual([
      { id: 't1', type: 'gl:fade', leftClipId: 'c1', rightClipId: 'c2', durationUs: 500_000 },
    ]);
  });

  it('reads video clips persisted only in the universal timeline', () => {
    const universalOnly = {
      ...TIMELINE,
      schemaVersion: 1,
      compositions: {
        root: { ...TIMELINE.compositions.root, tracks: [{ id: 'v1', family: 'video', clips: [] }] },
      },
      universalTimeline: {
        schemaVersion: 1,
        items: [
          {
            id: 'semantics-video',
            compositionId: 'root',
            trackId: 'v1',
            elementKind: 'video',
            startUs: 0,
            durationUs: 3_000_000,
            sourceInUs: 0,
            source: { kind: 'asset', id: 'video-asset' },
            withinTrackOrder: 0,
          },
        ],
      },
    };
    const visual = {
      assets: { 'video-asset': { id: 'video-asset', displayName: 'semantics-clip-test.mp4' } },
    };

    const clip = clipNamed(
      timelineFactsFrom(stores(universalOnly, visual)),
      'semantics-clip-test.mp4',
    );

    expect(clip).toMatchObject({
      id: 'semantics-video',
      trackId: 'v1',
      trackFamily: 'video',
      displayName: 'semantics-clip-test.mp4',
    });
  });

  it('does not count a universal item twice when its legacy projection is present', () => {
    const withBothRepresentations = {
      ...TIMELINE,
      schemaVersion: 1,
      compositions: {
        root: {
          ...TIMELINE.compositions.root,
          tracks: [
            {
              id: 'v1',
              family: 'video',
              clips: [
                {
                  id: 'semantics-video',
                  assetId: 'video-asset',
                  startUs: 0,
                  durationUs: 3_000_000,
                },
              ],
            },
          ],
        },
      },
      universalTimeline: {
        schemaVersion: 1,
        items: [
          {
            id: 'semantics-video',
            compositionId: 'root',
            trackId: 'v1',
            elementKind: 'video',
            startUs: 0,
            durationUs: 3_000_000,
            source: { kind: 'asset', id: 'video-asset' },
            withinTrackOrder: 0,
          },
        ],
      },
    };
    const visual = {
      assets: { 'video-asset': { id: 'video-asset', displayName: 'semantics-clip-test.mp4' } },
    };

    const facts = timelineFactsFrom(stores(withBothRepresentations, visual));

    expect(
      facts.clips.filter((clip) => clip.displayName === 'semantics-clip-test.mp4'),
    ).toHaveLength(1);
  });

  it('counts an audio item on the universal timeline as audio, not as a video clip', () => {
    const audioOnly = {
      ...TIMELINE,
      schemaVersion: 1,
      compositions: {
        root: { ...TIMELINE.compositions.root, tracks: [{ id: 'v1', family: 'video', clips: [] }] },
      },
      universalTimeline: {
        schemaVersion: 1,
        items: [
          {
            id: 'semantics-audio',
            compositionId: 'root',
            trackId: 'a1row',
            elementKind: 'audio',
            startUs: 0,
            durationUs: 3_000_000,
            sourceInUs: 0,
            source: { kind: 'asset', id: 'video-asset' },
            withinTrackOrder: 0,
          },
        ],
      },
    };
    const visual = {
      assets: { 'video-asset': { id: 'video-asset', displayName: 'semantics-clip-test.mp4' } },
    };

    const facts = timelineFactsFrom(stores(audioOnly, visual));

    expect(facts.clips).toEqual([
      expect.objectContaining({ id: 'semantics-audio', trackFamily: 'audio' }),
    ]);
    expect(() => clipNamed(facts, 'semantics-clip-test.mp4')).toThrow(
      'the timeline holds 0 clips of semantics-clip-test.mp4, not 1',
    );
  });

  it('ignores a universal item whose composition is not the root', () => {
    const nestedItem = {
      ...TIMELINE,
      schemaVersion: 1,
      compositions: {
        root: { ...TIMELINE.compositions.root, tracks: [{ id: 'v1', family: 'video', clips: [] }] },
      },
      universalTimeline: {
        schemaVersion: 1,
        items: [
          {
            id: 'semantics-root',
            compositionId: 'root',
            trackId: 'v1',
            elementKind: 'video',
            startUs: 0,
            durationUs: 3_000_000,
            sourceInUs: 0,
            source: { kind: 'asset', id: 'video-asset' },
            withinTrackOrder: 0,
          },
          {
            id: 'semantics-nested',
            compositionId: 'nested',
            trackId: 'v1',
            elementKind: 'video',
            startUs: 0,
            durationUs: 3_000_000,
            sourceInUs: 0,
            source: { kind: 'asset', id: 'video-asset' },
            withinTrackOrder: 0,
          },
        ],
      },
    };
    const visual = {
      assets: { 'video-asset': { id: 'video-asset', displayName: 'semantics-clip-test.mp4' } },
    };

    const facts = timelineFactsFrom(stores(nestedItem, visual));

    expect(facts.clips.map((clip) => clip.id)).toEqual(['semantics-root']);
  });

  it('ignores a universal item whose source is not an asset', () => {
    for (const kind of ['object', 'caption', 'composition', 'controller']) {
      const notAsset = {
        ...TIMELINE,
        schemaVersion: 1,
        compositions: {
          root: {
            ...TIMELINE.compositions.root,
            tracks: [{ id: 'v1', family: 'video', clips: [] }],
          },
        },
        universalTimeline: {
          schemaVersion: 1,
          items: [
            {
              id: `semantics-${kind}`,
              compositionId: 'root',
              trackId: 'v1',
              elementKind: 'video',
              startUs: 0,
              durationUs: 3_000_000,
              sourceInUs: 0,
              source: { kind, id: 'video-asset' },
              withinTrackOrder: 0,
            },
          ],
        },
      };
      const visual = {
        assets: { 'video-asset': { id: 'video-asset', displayName: 'semantics-clip-test.mp4' } },
      };

      expect(timelineFactsFrom(stores(notAsset, visual)).clips, kind).toEqual([]);
    }
  });

  it('takes the editor export rate when the composition has none', () => {
    const noRate = {
      ...TIMELINE,
      compositions: { root: { ...TIMELINE.compositions.root, frameRate: undefined } },
    };
    const facts = timelineFactsFrom(stores(noRate));
    expect(facts.frameRate).toBe(30);
    expect(facts.frameRateFromProject).toBe(false);
    expect(facts.transitions).toEqual([]);
  });

  it('refuses storage without an open project, a timeline or a sized root', () => {
    expect(() => timelineFactsFrom({})).toThrow('no active project');
    expect(() =>
      timelineFactsFrom({ [ACTIVE_PROJECT_KEY]: JSON.stringify({ projectId: 'p1' }) }),
    ).toThrow('no snapshot of p1');
    expect(() => timelineFactsFrom(stores({ rootCompositionId: 'x', compositions: {} }))).toThrow(
      'no root composition',
    );
    expect(() =>
      timelineFactsFrom(
        stores({ rootCompositionId: 'r', compositions: { r: { width: 0, height: 5 } } }),
      ),
    ).toThrow('no size');
    expect(() =>
      timelineFactsFrom({ ...stores(TIMELINE), [TIMELINE_LOG_KEY]: '{not json' }),
    ).toThrow('is not JSON');
  });
});

describe('placement, dissolve and samples', () => {
  const facts = timelineFactsFrom(stores(TIMELINE, VISUAL));

  it('finds each file once on a picture track, not counting linked audio', () => {
    expect(clipNamed(facts, names.videoName).id).toBe('c1');
    expect(() => clipNamed(facts, 'other.mp4')).toThrow('0 clips of other.mp4');
  });

  it('accepts the still within the junction tolerance of the clip end, and refuses a gap', () => {
    expect(placementOf(facts, names).still.id).toBe('c2');
    const gap: TimelineFacts = {
      ...facts,
      clips: facts.clips.map((clip): FactClip =>
        clip.id === 'c2' ? { ...clip, startUs: 3_100_000 } : clip,
      ),
    };
    expect(() => placementOf(gap, names)).toThrow('not where the clip ends');
  });

  it('finds the Dissolve and refuses a missing or a long one', () => {
    const placement = placementOf(facts, names);
    expect(dissolveOf(facts, placement).durationUs).toBe(500_000);
    expect(() => dissolveOf({ ...facts, transitions: [] }, placement)).toThrow('0 transitions');
    expect(() =>
      dissolveOf(
        { ...facts, transitions: [{ ...facts.transitions[0]!, durationUs: 4_000_000 }] },
        placement,
      ),
    ).toThrow('does not fit the clip');
    expect(
      dissolveOf(
        { ...facts, transitions: [{ ...facts.transitions[0]!, type: 'dissolve' }] },
        placement,
      ).type,
    ).toBe('dissolve');
  });

  it('plans two clip frames, one still frame and the middle of the Dissolve', () => {
    const placement = placementOf(facts, names);
    const expectation = expectationFrom(facts);
    expect(expectation.durationUs).toBe(5_000_400);
    const plan = samplePlan(placement, dissolveOf(facts, placement), expectation);
    const fps = facts.frameRate;
    const windowStart = 3_000_400 - 500_000;
    expect(plan.pictureFrames).toHaveLength(3);
    for (const frame of plan.pictureFrames) {
      const us = (frame * 1_000_000) / fps;
      expect(us < windowStart || us >= 3_000_400).toBe(true);
    }
    expect(plan.dissolve?.progress).toBeGreaterThan(0.4);
    expect(plan.dissolve?.progress).toBeLessThan(0.6);
    // The source time adds the clip's in point.
    expect(plan.dissolve?.fromSourceSeconds).toBeCloseTo(
      (plan.dissolve!.frame * 1_000_000) / fps / 1_000_000 + 0.5,
      6,
    );
    expect(plan.dissolve?.toFrame).toBe(plan.pictureFrames[2]);
  });

  it('refuses clips too short to sample and notes a Dissolve too short for a middle frame', () => {
    const placement = placementOf(facts, names);
    const expectation = expectationFrom(facts);
    const short = { ...placement, still: { ...placement.still, durationUs: 50_000 } };
    expect(() => samplePlan(short, undefined, expectation)).toThrow('too short to sample');
    const plan = samplePlan(
      placement,
      { type: 'gl:fade', leftClipId: 'c1', rightClipId: 'c2', durationUs: 30_000 },
      expectation,
    );
    expect(plan.dissolve).toBeUndefined();
    expect(plan.dissolveProblem).toContain('too short');
  });

  it('reads a video frame a quarter frame early, so the frame at or after the time is the one asked for', () => {
    expect(seekSecondsOf(0, 30)).toBe(0);
    expect(seekSecondsOf(30, 30)).toBeCloseTo(0.991667, 5);
  });
});

const GOOD_PROBE: SemanticsProbe = {
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationSeconds: 6.0,
  video: [{ codec: 'h264', width: 1920, height: 1080, durationSeconds: 6.0, frameRate: 30 }],
  audio: [{ codec: 'aac', channels: 2, sampleRate: 48_000 }],
};
const EXPECTATION = {
  width: 1920,
  height: 1080,
  frameRate: 30,
  durationUs: 6_000_000,
  frameCount: 180,
};

describe('the measured checks as functions', () => {
  it('reads an ffprobe report', () => {
    const probe = semanticsProbeFrom({
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '6.016000' },
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          duration: '6.000000',
          avg_frame_rate: '30/1',
          r_frame_rate: '30/1',
        },
        { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
      ],
    });
    expect(probe).toEqual({ ...GOOD_PROBE, durationSeconds: 6.016 });
    expect(() => semanticsProbeFrom(null)).toThrow('not a JSON object');
  });

  it('reads an ffprobe rate, and refuses a zero or unreadable one', () => {
    expect(probeRateOf('30/1')).toBe(30);
    expect(probeRateOf('30000/1001')).toBeCloseTo(29.97, 2);
    expect(probeRateOf('0/0')).toBeUndefined();
    expect(probeRateOf('0/1')).toBeUndefined();
    expect(probeRateOf('thirty')).toBeUndefined();
    expect(probeRateOf(undefined)).toBeUndefined();
    const fallback = semanticsProbeFrom({
      streams: [
        { codec_type: 'video', codec_name: 'h264', avg_frame_rate: '0/0', r_frame_rate: '25/1' },
      ],
    });
    expect(fallback.video[0]?.frameRate).toBe(25);
  });

  it('stream layout: passes the preset layout and names each difference', () => {
    expect(streamLayoutBlockers(GOOD_PROBE, EXPECTATION)).toEqual([]);
    expect(
      streamLayoutBlockers(
        {
          formatName: 'matroska,webm',
          durationSeconds: 6,
          video: [{ codec: 'vp9', width: 1920, height: 1080, frameRate: 30 }],
          audio: [
            { codec: 'opus', channels: 2, sampleRate: 48_000 },
            { codec: 'aac', channels: 2, sampleRate: 48_000 },
          ],
        },
        EXPECTATION,
      ),
    ).toEqual([
      'the container is matroska,webm, not mp4',
      'there are 2 audio streams, not 1',
      'the video codec is vp9, not h264',
      'the audio codec is opus, not aac',
    ]);
  });

  it('stream layout: records and fails a video whose frame rate is not the composition one', () => {
    expect(
      streamLayoutBlockers(
        { ...GOOD_PROBE, video: [{ ...GOOD_PROBE.video[0]!, frameRate: 25 }] },
        EXPECTATION,
      ),
    ).toEqual(["the video runs at 25 fps, not the composition's 30 fps"]);
    expect(
      streamLayoutBlockers(
        { ...GOOD_PROBE, video: [{ ...GOOD_PROBE.video[0]!, frameRate: undefined }] },
        EXPECTATION,
      ),
    ).toEqual(['the video frame rate was not read']);
  });

  it('stream layout: a composition at another rate than the export presets fails, even when the file matches it', () => {
    const at25 = { ...EXPECTATION, frameRate: 25 };
    expect(
      streamLayoutBlockers(
        { ...GOOD_PROBE, video: [{ ...GOOD_PROBE.video[0]!, frameRate: 25 }] },
        at25,
      ),
    ).toEqual(['the composition runs at 25 fps, but the export presets write 30 fps']);
    // ffprobe's 29.97 is a real difference from the presets' 30, so it is named too.
    expect(
      streamLayoutBlockers(
        { ...GOOD_PROBE, video: [{ ...GOOD_PROBE.video[0]!, frameRate: 29.97 }] },
        { ...EXPECTATION, frameRate: 29.97 },
      ).join(' | '),
    ).toContain('the composition runs at 29.97 fps, but the export presets write 30 fps');
  });

  it('every export preset writes the frame rate the scenario expects', () => {
    for (const preset of Object.values(EXPORT_PRESETS)) {
      expect(preset.frameRate).toBe(EXPORT_PRESET_FRAME_RATE);
    }
  });

  it('stream layout: rejects audio encoded at a different sample rate than the preset', () => {
    expect(
      streamLayoutBlockers(
        {
          ...GOOD_PROBE,
          audio: [{ ...GOOD_PROBE.audio[0]!, sampleRate: 44_100 }],
        },
        EXPECTATION,
      ),
    ).toContain('the audio sample rate is 44100 Hz, not 48000 Hz');
  });

  it('duration: one frame either way passes, more fails, and the stream duration counts too', () => {
    expect(durationBlockers({ ...GOOD_PROBE, durationSeconds: 6.033 }, EXPECTATION)).toEqual([]);
    expect(durationBlockers({ ...GOOD_PROBE, durationSeconds: 6.07 }, EXPECTATION)).toHaveLength(1);
    expect(
      durationBlockers(
        {
          ...GOOD_PROBE,
          video: [{ codec: 'h264', width: 1920, height: 1080, durationSeconds: 5.5 }],
        },
        EXPECTATION,
      ),
    ).toEqual(["the video stream lasts 5.5 s, not the timeline's 6.000 s within one frame"]);
    expect(
      durationBlockers({ ...GOOD_PROBE, durationSeconds: Number.NaN }, EXPECTATION),
    ).toHaveLength(1);
  });

  it('frame count: exact only', () => {
    expect(frameCountBlockers(180, EXPECTATION)).toEqual([]);
    expect(frameCountBlockers(181, EXPECTATION)).toEqual([
      "ffmpeg decoded 181 frames, not the timeline's 180",
    ]);
    expect(frameCountBlockers(Number.NaN, EXPECTATION)).toEqual([
      'the decoded frame count was not read',
    ]);
  });

  it('audio: two channels above the silence level', () => {
    expect(audioBlockers(GOOD_PROBE, [-21, -21.4])).toEqual([]);
    expect(audioBlockers(GOOD_PROBE, [-21, Number.NEGATIVE_INFINITY])).toHaveLength(1);
    expect(audioBlockers(GOOD_PROBE, [-21])).toEqual(['1 audio channels were decoded, not 2']);
    expect(audioBlockers({ ...GOOD_PROBE, audio: [] }, [])).toEqual([
      'the file has no audio stream',
    ]);
  });

  it("parses each channel's RMS from ffmpeg's astats report and skips Overall", () => {
    const text = [
      '[Parsed_astats_0 @ 000001d] Channel: 1',
      '[Parsed_astats_0 @ 000001d] DC offset: 0.000002',
      '[Parsed_astats_0 @ 000001d] RMS level dB: -21.072025',
      '[Parsed_astats_0 @ 000001d] RMS peak dB: -18.0',
      '[Parsed_astats_0 @ 000001d] Channel: 2',
      '[Parsed_astats_0 @ 000001d] RMS level dB: -inf',
      '[Parsed_astats_0 @ 000001d] Overall',
      '[Parsed_astats_0 @ 000001d] RMS level dB: -24.1',
    ].join('\r\n');
    expect(parseAstatsRms(text)).toEqual([-21.072025, Number.NEGATIVE_INFINITY]);
    expect(parseAstatsRms('no stats here')).toEqual([]);
  });
});

describe('the audio rule follows the real export presets', () => {
  it('expects the sample rate and the channel count that every preset writes', () => {
    const audio = Object.values(EXPORT_PRESETS).map((preset) => preset.audio);
    expect(audio.length).toBeGreaterThan(0);
    // If a preset changes its audio, this fails here, not on the first live run.
    for (const settings of audio) {
      expect(settings.sampleRate).toBe(EXPECTED_AUDIO_SAMPLE_RATE);
      expect(settings.channels).toBe(2);
      expect(settings.codec).toBe('aac');
    }
  });
});
