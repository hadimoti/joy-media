import { describe, expect, it, vi } from 'vitest';
import type { AudioState } from '@joy-media/commands';
import type { JoyProjectV1, SpikeProject, VideoClip } from '@joy-media/project-schema';
import { emptySpikeProject, makeVideoClip, withClips } from '@joy-media/test-fixtures';
import { EMPTY_AUDIO_STATE, withProjectAudio } from '../audio-session.js';
import { EditorSession } from '../editor-session.js';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { createEvidenceStore } from '../media-observation/evidence-store.js';
import {
  createTimelineQcSampler,
  type TimelineQcCanvasFactory,
  type TimelineQcTextBox,
} from '../media-observation/qc-sampler.js';
import { runBoundedToolExchange, type JoyAgentHostToolName } from './bounded-tool-loop.js';
import type { HostRpcHandlerContext, HostRpcJson, HostRpcMethod } from './host-rpc.js';
import {
  createQcHostAdapter,
  qcTimelineSourceFromTimeline,
  type QcHostAdapter,
  type QcTimelineSource,
} from './qc-host-adapter.js';
import { createQcRepairHost, timelineQcCheckPort, type QcCheckPort } from './qc-repair-host.js';
import type { QcRepairFinding, QcRepairPlan } from './qc-repair-plan.js';
import { createJoyAgentHostRpcMethodsForSnapshot } from './tool-bridge.js';

/**
 * T-B06 acceptance: a cut with three planted faults (one second of black at the
 * head, a whole cut that is too quiet, a title outside the safe area) ends with
 * zero of them after ONE approved plan, and one Undo restores the original
 * documents byte for byte.
 *
 * What is real here: the editor session and its Undo, the QC host adapter, the
 * T-B03 sampler with its safe-area check (on a fake canvas), the host RPC
 * methods the model calls, the bounded tool loop with a scripted stub model, the
 * repair planner, the loop driver and the one-transaction commit.
 *
 * What is a test double: the file check. Black and loudness are measured by the
 * Worker's ffmpeg job on an export, which a unit test cannot run. The double
 * below measures the same two faults from the planted source facts and the
 * project, the way the Worker would see them in an export of this cut.
 */

const S = 1_000_000;
const TITLE_ID = 'qc-title';
const TITLE_WIDTH_PX = 400;
const TITLE_HEIGHT_PX = 100;
/** Planted: the first second of shot A's source file is black. */
const PLANTED_BLACK_SOURCE = { assetId: 'asset-a', startUs: 0, endUs: 1 * S };
/** Planted: the mix measures -32 LUFS at unity gain, with peaks at -20 dBFS. */
const PLANTED_LUFS_AT_UNITY = -32;
const PLANTED_PEAK_AT_UNITY = -20;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

function fixtureTimeline(): SpikeProject {
  const base = emptySpikeProject({
    trackCount: 1,
    durationUs: 8 * S,
    frameRate: { num: 30, den: 1 },
  });
  return withClips(base, 'track-0', [
    makeVideoClip('a', 0, 4 * S, { sourceInUs: 0 }),
    makeVideoClip('b', 4 * S, 4 * S, { sourceInUs: 0 }),
  ]);
}

function fixtureDocument(): JoyProjectV1 {
  const document: JoyProjectV1 = {
    ...INITIAL_EDITOR_PROJECT,
    visualObjects: {
      ...INITIAL_EDITOR_PROJECT.visualObjects,
      [TITLE_ID]: {
        id: TITLE_ID,
        kind: 'text',
        text: 'Hello',
        transform: {
          // Planted: 10 px from the left edge of a 1080 px frame, outside the 5 percent margin.
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
  return withProjectAudio(document, EMPTY_AUDIO_STATE);
}

function audioOf(document: JoyProjectV1): AudioState {
  const audio = document.audio!;
  return {
    clips: audio.clips,
    buses: audio.buses,
    effects: audio.effects as unknown as AudioState['effects'],
  };
}

/** The title's box as fractions of the frame, read from the live document. */
function titleBoxes(document: JoyProjectV1): TimelineQcTextBox[] {
  const title = document.visualObjects[TITLE_ID];
  const root = document.compositions[document.rootCompositionId]!;
  if (title === undefined) return [];
  return [
    {
      id: TITLE_ID,
      kind: 'title',
      startUs: 5 * S,
      endUs: 7 * S,
      x: title.transform.x / root.width,
      y: title.transform.y / root.height,
      width: TITLE_WIDTH_PX / root.width,
      height: TITLE_HEIGHT_PX / root.height,
      textColor: { r: 255, g: 255, b: 255, a: 255 },
    },
  ];
}

const canvasFactory: TimelineQcCanvasFactory = (width, height) => {
  const imageContext = {
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: () => undefined,
    drawImage: () => undefined,
  };
  return {
    width,
    height,
    getContext: () => imageContext,
    convertToBlob: async ({ type }) => new Blob([new Uint8Array(8)], { type }),
  };
};

/** Dark frames, so the white title is legible and only its place can fail. */
function fakeComposition(): NonNullable<QcTimelineSource['composition']> {
  const dark = () => {
    const data = new Uint8Array(8 * 8 * 4);
    for (let index = 3; index < data.length; index += 4) data[index] = 255;
    return data;
  };
  return {
    snapshot: {
      kind: 'canonical',
      compositionId: 'root',
      projectRevision: 'revision-1',
      rendererVersion: 'renderer-v1',
      evaluatorVersion: 'evaluator-v1',
      dependencyDigests: ['b'.repeat(64)],
      state: {},
    },
    readiness: {
      check: () => ({ asset: 'ready', font: 'ready', scene: 'ready', shader: 'ready' }),
    },
    evaluator: {
      version: 'evaluator-v1',
      evaluate: (_snapshot, timeUs) => ({
        version: 1 as const,
        compositionId: 'root',
        timeUs,
        viewport: { width: 8, height: 8, dpr: 1 },
        background: { r: 0, g: 0, b: 0, a: 255 },
        nodes: [],
      }),
    },
    renderer: {
      version: 'renderer-v1',
      renderAndReadback: () => ({ width: 8, height: 8, data: dark() }),
    },
  };
}

/** The Worker-file-check double: black from the planted source range, loudness from the mix gain. */
function fileCheckDouble(session: EditorSession): QcCheckPort {
  return {
    async check(scope) {
      const findings: QcRepairFinding[] = [];
      const root = session.timelineProject.compositions[session.timelineProject.rootCompositionId]!;
      let n = 0;
      for (const track of root.tracks)
        for (const clip of track.clips) {
          if (clip.kind !== 'video' || clip.assetId !== PLANTED_BLACK_SOURCE.assetId) continue;
          const video = clip as VideoClip;
          const from = Math.max(video.sourceInUs, PLANTED_BLACK_SOURCE.startUs);
          const to = Math.min(video.sourceInUs + video.durationUs, PLANTED_BLACK_SOURCE.endUs);
          if (to <= from) continue;
          const startUs = video.startUs + (from - video.sourceInUs);
          const endUs = video.startUs + (to - video.sourceInUs);
          const seen =
            scope === 'all' ||
            scope.some((range) => startUs < range.endUs && endUs > range.startUs);
          if (seen)
            findings.push({
              id: `file-${++n}`,
              type: 'black',
              startUs,
              endUs,
              measured: { blackDurationUs: endUs - startUs },
            });
        }
      const master = audioOf(session.visualProject).buses.find((bus) => bus.id === 'master')!;
      const gainDb = 20 * Math.log10(master.gain);
      const lufs = PLANTED_LUFS_AT_UNITY + gainDb;
      if (lufs < -26 || lufs > -9)
        findings.push({
          id: `file-${++n}`,
          type: 'loudness',
          startUs: 0,
          endUs: 8 * S,
          measured: { integratedLufs: lufs, truePeakDbfs: PLANTED_PEAK_AT_UNITY + gainDb },
        });
      return { ok: true, findings };
    },
  };
}

function hostContext(): HostRpcHandlerContext {
  return {
    run: { runId: 'run-qc-e2e', epoch: 1 },
    requestId: 'request-1',
    signal: new AbortController().signal,
    deadlineAt: Number.MAX_SAFE_INTEGER,
  };
}

function editorAdapter(session: EditorSession): QcHostAdapter {
  return createQcHostAdapter({
    evidenceStore: createEvidenceStore(),
    identity: () => ({
      runId: 'run-qc-e2e',
      projectId: session.timelineProject.id,
      revision: session.projectRevisionId,
      modelId: 'stub-model',
      promptPolicyDigest: 'policy-1',
    }),
    timeline: () => {
      const source = qcTimelineSourceFromTimeline(
        session.timelineProject,
        fakeComposition(),
        titleBoxes(session.visualProject),
      );
      return source;
    },
    sampler: createTimelineQcSampler({ canvasFactory }),
    isCachedImageSupported: () => false,
    isPrivacyModeAllowed: () => false,
    digest: async () => 'c'.repeat(64),
    now: () => Date.UTC(2026, 10, 15),
    evenFrameCount: 4,
  });
}

/** The scripted stub model: it asks for the latest report, then answers in text. */
async function stubModelReadsReport(adapter: QcHostAdapter) {
  const methods = createJoyAgentHostRpcMethodsForSnapshot(
    { projectId: 'project-1', revision: 'revision-1' },
    undefined,
    undefined,
    undefined,
    undefined,
    adapter,
  );
  const requests: (readonly unknown[])[] = [];
  let step = 0;
  await runBoundedToolExchange(
    [],
    async (messages) => {
      requests.push(structuredClone(messages));
      step += 1;
      const call = (id: string, name: string, args: unknown) =>
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
                ],
              },
            },
          ],
        });
      if (step === 1) return call('context', 'read_project_context', { domain: 'overview' });
      if (step === 2)
        return call('read', 'qc_report_read', { reportId: 'latest', includeFindings: true });
      return JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Fix it.' } }] });
    },
    async (method: JoyAgentHostToolName, args: HostRpcJson) => {
      const handler = methods[method] as HostRpcMethod<HostRpcJson, HostRpcJson> | undefined;
      if (handler === undefined) throw new Error(`unexpected host call ${method}`);
      return handler.execute(handler.parseArgs(args), hostContext());
    },
    { allowedToolNames: ['read_project_context', 'qc_report_read'] },
  );
  const toolMessage = (requests.at(-1) ?? []).find(
    (item): item is { role: string; content: string; tool_call_id: string } =>
      typeof item === 'object' &&
      item !== null &&
      (item as { role?: unknown }).role === 'tool' &&
      (item as { tool_call_id?: unknown }).tool_call_id === 'read',
  );
  return toolMessage === undefined
    ? undefined
    : (JSON.parse(toolMessage.content) as { findings?: { type: string }[] });
}

describe('QC fix loop end to end (T-B06)', () => {
  it('repairs three planted faults with one approved plan, and one Undo restores the documents', async () => {
    const session = new EditorSession(memoryStorage(), fixtureTimeline(), fixtureDocument());
    const originalTimeline = JSON.stringify(session.timelineProject);
    const originalDocument = JSON.stringify(session.visualProject);
    const adapter = editorAdapter(session);
    const approvals: QcRepairPlan[] = [];
    const approve = vi.fn(async (plan: QcRepairPlan) => {
      approvals.push(plan);
      return true;
    });
    const host = createQcRepairHost({
      session,
      checks: [timelineQcCheckPort(adapter), fileCheckDouble(session)],
      getAudio: () => audioOf(session.visualProject),
      textBoxes: () => titleBoxes(session.visualProject),
      approve,
      maxRounds: 3,
    });

    // Layer 1 runs as a host action and its report is kept for the model to read.
    const initial = await host.checkAll(new AbortController().signal);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    expect(initial.findings.map((finding) => finding.type).sort()).toEqual([
      'black',
      'loudness',
      'safe-area',
    ]);
    adapter.storeFileReport({
      version: 1,
      reportId: 'qc-report-combined-1',
      target: { kind: 'timeline' },
      findings: initial.findings as unknown as HostRpcJson[],
    });

    // The stub model reads the report through the real qc_report_read tool.
    const seen = await stubModelReadsReport(adapter);
    expect(seen?.findings?.map((finding) => finding.type).sort()).toEqual([
      'black',
      'loudness',
      'safe-area',
    ]);

    // One plan, one approval, one transaction, then the re-check of the changed ranges.
    const historyBefore = session.historyCursorSequence;
    const result = await host.run(new AbortController().signal, initial.findings);
    expect(result.stop).toBe('clean');
    expect(approve).toHaveBeenCalledTimes(1);
    expect(result.rounds).toHaveLength(1);
    expect(approvals[0]!.notRepairable).toEqual([]);
    expect(approvals[0]!.edits.map((edit) => edit.kind).sort()).toEqual(['cut', 'gain', 'move']);
    expect(approvals[0]!.agentPlan.status).toBe('pending-approval');
    expect(result.remainingFindings).toEqual([]);
    expect(session.historyCursorSequence).toBe(historyBefore + 1);

    // A full check afterwards agrees: none of the three faults is left.
    const after = await host.checkAll(new AbortController().signal);
    expect(after).toEqual({ ok: true, findings: [] });
    expect(JSON.stringify(session.timelineProject)).not.toBe(originalTimeline);

    // One Undo restores both documents byte for byte.
    session.undo();
    expect(JSON.stringify(session.timelineProject)).toBe(originalTimeline);
    expect(JSON.stringify(session.visualProject)).toBe(originalDocument);
    const reverted = await host.checkAll(new AbortController().signal);
    expect(reverted.ok && reverted.findings.map((finding) => finding.type).sort()).toEqual([
      'black',
      'loudness',
      'safe-area',
    ]);
  });

  it('re-samples only the changed ranges after a plan', async () => {
    const session = new EditorSession(memoryStorage(), fixtureTimeline(), fixtureDocument());
    const adapter = editorAdapter(session);
    const ranged = vi.spyOn(adapter, 'runTimelineCheck');
    const host = createQcRepairHost({
      session,
      checks: [timelineQcCheckPort(adapter)],
      getAudio: () => audioOf(session.visualProject),
      textBoxes: () => titleBoxes(session.visualProject),
      approve: async () => true,
      maxRounds: 3,
    });
    const result = await host.run(new AbortController().signal);
    expect(result.stop).toBe('clean');
    expect(ranged).toHaveBeenCalledTimes(2);
    expect(ranged.mock.calls[0]![1]).toBeUndefined();
    expect(ranged.mock.calls[1]![1]).toEqual([{ startUs: 5 * S, endUs: 7 * S }]);
    const recheck = adapter.storedReport('latest') as {
      checkedRanges?: unknown;
      frames: { timeUs: number }[];
    };
    expect(recheck.checkedRanges).toEqual([{ startUs: 5 * S, endUs: 7 * S }]);
    expect(recheck.frames.every((frame) => frame.timeUs >= 5 * S && frame.timeUs < 7 * S)).toBe(
      true,
    );
  });

  it('stops without a change when the owner declines the plan', async () => {
    const session = new EditorSession(memoryStorage(), fixtureTimeline(), fixtureDocument());
    const original = JSON.stringify(session.timelineProject);
    const adapter = editorAdapter(session);
    const host = createQcRepairHost({
      session,
      checks: [timelineQcCheckPort(adapter), fileCheckDouble(session)],
      getAudio: () => audioOf(session.visualProject),
      textBoxes: () => titleBoxes(session.visualProject),
      approve: async () => false,
      maxRounds: 3,
    });
    const result = await host.run(new AbortController().signal);
    expect(result.stop).toBe('declined');
    expect(result.remainingFindings).toHaveLength(3);
    expect(JSON.stringify(session.timelineProject)).toBe(original);
  });
});
