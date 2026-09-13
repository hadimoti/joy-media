import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { expect, test, type Download, type Page, type TestInfo } from '@playwright/test';
import {
  authenticate,
  MEDIA_FIXTURE_DIR,
  importMediaFixture,
  openPanel,
  openDisposableWorkspace,
} from './wp29-r5-harness.js';
import { armExportObserver } from './helpers/p3-export-observer.mjs';
import {
  effectiveProjectStateMismatches,
  hashEffectiveProjectState,
  p3CaseWorkspaceTitle,
} from '../../ops/self-hosted/linux-runner/p3-case-isolation.mjs';
import {
  compareExactFrameCount,
  expectedPresentationFrameCount,
  validateIntendedResolution,
  validateDecodedPixelSamples,
} from '../../ops/self-hosted/linux-runner/p3-media-assertions.mjs';
import {
  P3_CASE_REGISTRY,
  P3_PRESETS,
  attachProvenance,
  markResult,
  markStarted,
  newP3Matrix,
  p3Provenance,
} from '../../ops/self-hosted/linux-runner/p3-case-registry.mjs';
import {
  newP3CaseEvidence,
  persistP3CaseEvidence,
  setCaseFinished,
  setCaseStarted,
} from '../../ops/self-hosted/linux-runner/p3-case-evidence.mjs';

// P3MatrixRow mirrors the runtime shape produced by newP3Matrix() and the
// helpers in p3-case-registry.mjs. The registry is pure ESM with JSDoc
// typedefs, so the TS type is derived locally here from ReturnType — keeps
// the contract in one place without a second .d.ts file.
type P3MatrixRow = ReturnType<typeof newP3Matrix>[number];
// P3CaseEvidenceAggregate mirrors the runtime shape produced by
// newP3CaseEvidence() in p3-case-evidence.mjs. The helper mutates via
// immutable return values (setCaseStarted / setCaseFinished always return a
// new aggregate), so the typed alias is intentionally the readonly shape.
type P3CaseEvidenceRow = {
  readonly caseId: string;
  readonly pack: string;
  readonly preset: string;
  readonly kind: string;
  readonly phase: 'NOT RUN' | 'started' | 'PASS' | 'FAIL';
  readonly result: 'NOT RUN' | 'PASS' | 'FAIL';
  readonly reason: string | null;
  readonly error: string | null;
  readonly evidence: Readonly<Record<string, unknown>> | null;
};
type P3CaseEvidenceAggregate = {
  readonly schemaVersion: number;
  readonly provenance: Readonly<Record<string, string>>;
  readonly generatedAt: string;
  readonly cases: readonly P3CaseEvidenceRow[];
};
type CaseKind = 'export' | 'cancel';

type ExportPreset = (typeof P3_PRESETS)[number];
type LookPack = (typeof P3_CASE_REGISTRY.packs)[number];

const PRESETS: readonly ExportPreset[] = P3_PRESETS.map((preset) => ({ ...preset }));
const LOOK_PACKS: readonly LookPack[] = P3_CASE_REGISTRY.packs.map((pack) => ({ ...pack }));
// The browser stage is followed by real Worker verification/remux. The
// self-hosted real-service harness gives that bounded path a 35-minute window;
// keep the matrix aligned so a valid export is not reported as a browser
// download timeout while the Worker is still finishing.
const EXPORT_TIMEOUT_MS = 35 * 60_000;

const ACTIVE_PROJECT_KEY = 'joy-media.active-project.v1';
const TIMELINE_LOG_KEY = 'joy-media.timeline-project-log.v1';

const MATRIX_PATH = 'test-output/browser/p3-export-matrix.json';
const GALLERY_ROOT = 'test-output/browser/p3-export-gallery';
const GALLERY_MANIFEST_PATH = 'test-output/browser/p3-export-gallery/manifest.json';

// Sync-event sampling: probe the container at three points (early/mid/late).
// The early sample is intentionally outside any seek/edit list pre-roll so
// drift attributable to the AAC encoder's negative first-packet PTS can be
// separated from real timeline drift.
const SYNC_SAMPLE_FRACTIONS = [0.1, 0.5, 0.9] as const;
const SYNC_EARLY_FRAME = 6;
// AAC encoder pre-roll observed across the proxy/intended samples: first audio
// packet pts_time = -0.021333s for the standard ffmpeg aac encoder, and
// `frame-sweep.mjs:79` shows an extra ~21ms of container over-run when the
// rendering pipeline concatenates segments. Both effects MUST be subtracted
// when reporting drift vs the project timeline.
const AAC_PREROLL_S = 0.021333;
// Container over-run observed for the intended-resolution 1080p concat path;
// the value is the measured `format.duration - durationUs / 1e6` delta from
// `joy-r2-p0-provenance-report-2026-09-09.md` §2b. Negative means the timeline
// is treated as longer than the video stream.
const CONTAINER_OVERRUN_S = 0.021029;
// Composite codec-delay budget. A drift exceeding this on ANY sample, AFTER
// both corrections are applied, indicates a real timeline/audio mismatch and
// is the only condition that should fail the case.
const SYNC_DRIFT_BUDGET_S = 0.05;

const P3_PROGRESS_PATH = process.env.JOY_P3_PROGRESS_PATH;
const P3_PROGRESS_STARTED_AT_MS = Number(process.env.JOY_P3_PROGRESS_STARTED_AT_MS ?? Date.now());
const P3_PROGRESS_DEADLINE_MS = Number(process.env.JOY_P3_EXECUTION_DEADLINE_MS ?? Infinity);
const P3_PROGRESS_MAX_LINES = 256;
let p3ProgressQueue = Promise.resolve();
let p3ProgressLines = 0;

async function writeP3Progress({
  caseId = null,
  phase,
  result = null,
}: {
  readonly caseId?: string | null;
  readonly phase: string;
  readonly result?: string | null;
}): Promise<void> {
  if (P3_PROGRESS_PATH === undefined || P3_PROGRESS_PATH.length === 0) return;
  if (p3ProgressLines >= P3_PROGRESS_MAX_LINES) return;
  p3ProgressLines += 1;
  const record = {
    candidateSha:
      process.env.JOY_MEDIA_CI_CANDIDATE_SHA ?? '0000000000000000000000000000000000000000',
    runId: process.env.JOY_MEDIA_CI_RUN_ID ?? '0',
    runAttempt: process.env.JOY_MEDIA_CI_RUN_ATTEMPT ?? '0',
    pass: process.env.JOY_MEDIA_CI_LANE_PASS ?? '1',
    caseId,
    phase,
    elapsedMs: Math.max(0, Date.now() - P3_PROGRESS_STARTED_AT_MS),
    deadlineMs: Number.isFinite(P3_PROGRESS_DEADLINE_MS) ? P3_PROGRESS_DEADLINE_MS : null,
    result,
    utc: new Date().toISOString(),
  };
  p3ProgressQueue = p3ProgressQueue.then(() =>
    appendFile(P3_PROGRESS_PATH, `${JSON.stringify(record)}\n`, { encoding: 'utf8' }),
  );
  await p3ProgressQueue;
}

// Matrix row types and the exact 20-row registry (5 packs × 2 presets ×
// export/cancel) come from the shared P3 registry so the browser spec, the
// harness validator, and the vitest tests cannot drift apart. Use the
// helpers (newP3Matrix / markStarted / markResult / attachProvenance) so the
// `phase` is honestly separate from `result` and persistence is atomic.

async function returnToProjectSelector(page: Page): Promise<void> {
  // The reference project is intentionally persisted. Clear only the active
  // selection before the next cold navigation so each matrix case exercises
  // the real selector/reopen path without inheriting the previous editor.
  // Playwright starts a fresh test page at about:blank; establish the app
  // origin before reading or writing localStorage so the reset itself cannot
  // fail with a document-security error.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((key) => {
    window.localStorage.setItem(key, JSON.stringify({ version: 1, projectId: null }));
  }, ACTIVE_PROJECT_KEY);
  // The first navigation may already have mounted the editor using the
  // previously persisted id. Reload so App's initial state reads the cleared
  // selection and renders the Projects library before the next case.
  await page.reload({ waitUntil: 'domcontentloaded' });
}

type EffectiveProjectState = {
  readonly projectId: string;
  readonly timeline: {
    readonly snapshotCount: number;
    readonly transactionCount: number;
    readonly latestSnapshotRevision: number;
    readonly latestTransactionRevision: number;
  };
  readonly visual: {
    readonly snapshotCount: number;
    readonly transactionCount: number;
    readonly latestSnapshotRevision: number;
    readonly latestTransactionRevision: number;
  };
  /** Visual-project content with delivery-only export metadata removed. */
  readonly visualAuthoredHash?: string;
  readonly contentHash: string;
};

async function hashFixture(name: string): Promise<string> {
  const bytes = await readFile(join(MEDIA_FIXTURE_DIR, name));
  return createHash('sha256').update(bytes).digest('hex');
}

const P3_TEXT_FIXTURE_CONTENT = 'A Better Story';

/** Add one real text object through the shipped editor UI so every Look's
 * required visual-object slot can compile its text-template operation against
 * a text target rather than the imported video clip. */
async function addP3TextFixture(page: Page): Promise<void> {
  await openPanel(page, 'Text');
  await page.getByRole('button', { name: 'Add Clean Title', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Text content' })).toHaveValue(
    P3_TEXT_FIXTURE_CONTENT,
    { timeout: 15_000 },
  );
}

/** Read both effective BrowserProjectStore records, including transaction replay. */
async function readEffectiveProjectState(page: Page): Promise<EffectiveProjectState> {
  const raw = await page.evaluate(
    ({ activeKey, timelineKey, visualKey }) => {
      const parse = (key: string): unknown => {
        const value = window.localStorage.getItem(key);
        if (value === null) throw new Error(`missing localStorage key ${key}`);
        try {
          return JSON.parse(value) as unknown;
        } catch {
          throw new Error(`invalid JSON in localStorage key ${key}`);
        }
      };
      const active = parse(activeKey);
      if (active === null || typeof active !== 'object')
        throw new Error('active project record missing');
      const projectId = (active as { projectId?: unknown }).projectId;
      if (typeof projectId !== 'string' || projectId.length === 0)
        throw new Error('active project id missing');
      const inspect = (key: string) => {
        const log = parse(key);
        if (log === null || typeof log !== 'object') throw new Error(`project log missing: ${key}`);
        const projects = (log as { projects?: unknown }).projects;
        if (projects === null || typeof projects !== 'object')
          throw new Error(`project map missing: ${key}`);
        const project = (projects as Record<string, unknown>)[projectId];
        if (project === null || typeof project !== 'object')
          throw new Error(`project ${projectId} missing in ${key}`);
        const snapshots = (project as { snapshots?: unknown }).snapshots;
        const transactions = (project as { transactions?: unknown }).transactions;
        if (!Array.isArray(snapshots) || !Array.isArray(transactions))
          throw new Error(`effective records missing in ${key}`);
        const revisions = (rows: unknown[]) => {
          const values = rows.map((row) => {
            if (
              row === null ||
              typeof row !== 'object' ||
              typeof (row as { revision?: unknown }).revision !== 'number'
            )
              throw new Error(`malformed revision in ${key}`);
            return (row as { revision: number }).revision;
          });
          return values.length === 0 ? 0 : Math.max(...values);
        };
        let authoredJson: string | undefined;
        if (key === visualKey) {
          const latestSnapshot = [...snapshots].sort(
            (left, right) =>
              (right as { revision: number }).revision - (left as { revision: number }).revision,
          )[0] as { payload?: unknown } | undefined;
          if (latestSnapshot?.payload !== undefined && typeof latestSnapshot.payload === 'object') {
            const authored = { ...(latestSnapshot.payload as Record<string, unknown>) };
            delete authored.updatedAt;
            delete authored.exportPreset;
            authoredJson = JSON.stringify(authored);
          }
        }
        return {
          snapshotCount: snapshots.length,
          transactionCount: transactions.length,
          latestSnapshotRevision: revisions(snapshots),
          latestTransactionRevision: revisions(transactions),
          ...(authoredJson === undefined ? {} : { authoredJson }),
        };
      };
      const timeline = inspect(timelineKey);
      const visual = inspect(visualKey);
      return {
        projectId,
        timeline: {
          snapshotCount: timeline.snapshotCount,
          transactionCount: timeline.transactionCount,
          latestSnapshotRevision: timeline.latestSnapshotRevision,
          latestTransactionRevision: timeline.latestTransactionRevision,
        },
        visual: {
          snapshotCount: visual.snapshotCount,
          transactionCount: visual.transactionCount,
          latestSnapshotRevision: visual.latestSnapshotRevision,
          latestTransactionRevision: visual.latestTransactionRevision,
        },
        visualAuthoredJson: visual.authoredJson,
      };
    },
    {
      activeKey: ACTIVE_PROJECT_KEY,
      timelineKey: TIMELINE_LOG_KEY,
      visualKey: 'joy-media.visual-object-project-log.v1',
    },
  );
  const visualAuthoredHash =
    typeof raw.visualAuthoredJson === 'string'
      ? createHash('sha256').update(raw.visualAuthoredJson).digest('hex')
      : undefined;
  const contentHash = hashEffectiveProjectState({
    projectId: raw.projectId,
    timeline: raw.timeline,
    visualAuthoredHash,
  });
  return {
    projectId: raw.projectId,
    timeline: raw.timeline,
    visual: raw.visual,
    ...(visualAuthoredHash === undefined ? {} : { visualAuthoredHash }),
    contentHash,
  } as EffectiveProjectState;
}

function expectProjectUnchanged(before: EffectiveProjectState, after: EffectiveProjectState): void {
  expect(effectiveProjectStateMismatches(before, after)).toEqual([]);
}

/** Resolve a project's expected duration + frame count from the persisted
 *  timeline log. Returns `null` if the active project is not found or the
 *  timeline is missing — callers MUST treat that as a failure, not as an
 *  excuse to weaken the assertion. */
async function readProjectTimeline(page: Page): Promise<{
  readonly durationUs: number;
  readonly frameRateNum: number;
  readonly frameRateDen: number;
} | null> {
  return page.evaluate(
    ({ activeKey, timelineKey, visualKey }) => {
      const activeRaw = window.localStorage.getItem(activeKey);
      if (activeRaw === null) return null;
      let active: unknown;
      try {
        active = JSON.parse(activeRaw);
      } catch {
        return null;
      }
      const projectId =
        active !== null &&
        typeof active === 'object' &&
        (active as { projectId?: unknown }).projectId !== null &&
        typeof (active as { projectId?: unknown }).projectId === 'string'
          ? ((active as { projectId: string }).projectId as string)
          : null;
      if (projectId === null || projectId.length === 0) return null;
      const logRaw = window.localStorage.getItem(timelineKey);
      if (logRaw === null) return null;
      let log: unknown;
      try {
        log = JSON.parse(logRaw);
      } catch {
        return null;
      }
      const projects =
        log !== null && typeof log === 'object'
          ? (log as { projects?: unknown }).projects
          : undefined;
      if (projects === null || projects === undefined || typeof projects !== 'object') return null;
      const project = (projects as Record<string, unknown>)[projectId];
      if (project === null || project === undefined || typeof project !== 'object') return null;
      // BrowserProjectStore shape (packages/project-persistence/src/browser-store.ts):
      //   project = { snapshots: StoredSnapshot<SpikeProject>[],
      //               transactions: StoredTransaction[] }
      //   StoredSnapshot<SpikeProject> = { payload: SpikeProject,
      //                                    checksum, revision, schemaVersion }
      // The project may not have a snapshot yet (write-before-initialize); fall
      // back to the most recent snapshot's `payload` — the SpikeProject itself
      // — and read `compositions` from there.
      const snapshotsRaw = (project as { snapshots?: unknown }).snapshots;
      if (!Array.isArray(snapshotsRaw) || snapshotsRaw.length === 0) return null;
      let latestSnapshot: unknown;
      for (const candidate of snapshotsRaw) {
        if (candidate === null || candidate === undefined || typeof candidate !== 'object')
          return null;
        const rev = (candidate as { revision?: unknown }).revision;
        if (typeof rev !== 'number') return null;
        if (latestSnapshot === undefined) {
          latestSnapshot = candidate;
          continue;
        }
        const latestRev = (latestSnapshot as { revision: number }).revision;
        if (rev > latestRev) latestSnapshot = candidate;
      }
      if (latestSnapshot === undefined) return null;
      const spike =
        (latestSnapshot as { payload?: unknown }).payload !== undefined
          ? (latestSnapshot as { payload: unknown }).payload
          : latestSnapshot;
      if (spike === null || spike === undefined || typeof spike !== 'object') return null;
      const compositions = (spike as { compositions?: unknown }).compositions;
      if (compositions === null || compositions === undefined || typeof compositions !== 'object')
        return null;
      // Prefer `rootCompositionId` because the export pipeline renders the
      // root composition as the shipping target. Fall back to the first
      // available composition only when no root id is recorded.
      const rootId = (spike as { rootCompositionId?: unknown }).rootCompositionId;
      const rootComp =
        typeof rootId === 'string' ? (compositions as Record<string, unknown>)[rootId] : undefined;
      const comp =
        rootComp !== undefined && rootComp !== null
          ? (rootComp as { durationUs?: unknown; frameRate?: unknown })
          : (Object.values(compositions as Record<string, unknown>)[0] as
              { durationUs?: unknown; frameRate?: unknown } | undefined);
      if (comp === undefined) return null;
      const durationUs =
        typeof comp.durationUs === 'number' && Number.isFinite(comp.durationUs)
          ? comp.durationUs
          : null;
      const fr = comp.frameRate as { num?: unknown; den?: unknown } | undefined;
      const frameRateNum = fr !== undefined && typeof fr.num === 'number' ? fr.num : null;
      const frameRateDen =
        fr !== undefined && typeof fr.den === 'number' && fr.den > 0 ? fr.den : null;
      if (durationUs === null || frameRateNum === null || frameRateDen === null) return null;
      // The composition duration is a default canvas length (currently 60s),
      // while shipping export intentionally stops at the last authored item.
      // Read the persisted visual universal timeline so the assertion is tied
      // to the same project bytes that the real exporter consumes.
      let authoredEndUs = 0;
      const visualRaw = window.localStorage.getItem(visualKey);
      if (visualRaw !== null) {
        try {
          const visualLog = JSON.parse(visualRaw) as { projects?: unknown };
          const visualProjects = visualLog.projects;
          if (visualProjects !== null && typeof visualProjects === 'object') {
            const visualProject = (visualProjects as Record<string, unknown>)[projectId];
            if (visualProject !== null && typeof visualProject === 'object') {
              const visualSnapshots = (visualProject as { snapshots?: unknown }).snapshots;
              if (Array.isArray(visualSnapshots) && visualSnapshots.length > 0) {
                let latestVisual: { revision: number; payload?: unknown } | undefined;
                for (const candidate of visualSnapshots) {
                  if (
                    candidate === null ||
                    typeof candidate !== 'object' ||
                    typeof (candidate as { revision?: unknown }).revision !== 'number'
                  )
                    continue;
                  if (latestVisual === undefined || candidate.revision > latestVisual.revision)
                    latestVisual = candidate as { revision: number; payload?: unknown };
                }
                const visualPayload = latestVisual?.payload;
                if (visualPayload !== null && typeof visualPayload === 'object') {
                  const universal = (visualPayload as { universalTimeline?: unknown })
                    .universalTimeline;
                  const items =
                    universal !== null && typeof universal === 'object'
                      ? (universal as { items?: unknown }).items
                      : undefined;
                  const pluginData = (visualPayload as { pluginData?: unknown }).pluginData;
                  const kindMap =
                    pluginData !== null && typeof pluginData === 'object'
                      ? (pluginData as Record<string, unknown>)['joy.timelineElementKinds']
                      : undefined;
                  const controllers = new Set([
                    'caption',
                    'motion',
                    'effect',
                    'filter',
                    'adjust',
                    'adjustment',
                    'controller',
                    'camera',
                    'composition',
                  ]);
                  if (Array.isArray(items)) {
                    for (const item of items) {
                      if (item === null || typeof item !== 'object') continue;
                      const startUs = (item as { startUs?: unknown }).startUs;
                      const itemDurationUs = (item as { durationUs?: unknown }).durationUs;
                      if (
                        typeof startUs !== 'number' ||
                        !Number.isFinite(startUs) ||
                        typeof itemDurationUs !== 'number' ||
                        !Number.isFinite(itemDurationUs) ||
                        itemDurationUs <= 0
                      )
                        continue;
                      const itemId = (item as { id?: unknown }).id;
                      const directKind = (item as { elementKind?: unknown }).elementKind;
                      const mappedKind =
                        typeof itemId === 'string' &&
                        kindMap !== null &&
                        typeof kindMap === 'object'
                          ? (kindMap as Record<string, unknown>)[itemId]
                          : undefined;
                      const kind =
                        typeof directKind === 'string'
                          ? directKind
                          : typeof mappedKind === 'string'
                            ? mappedKind
                            : 'video';
                      if (!controllers.has(kind))
                        authoredEndUs = Math.max(authoredEndUs, startUs + itemDurationUs);
                    }
                  }
                }
              }
            }
          }
        } catch {
          // Keep the strict timeline fallback below; malformed visual bytes
          // must not make the acceptance assertion silently pass.
        }
      }
      return {
        durationUs: authoredEndUs > 0 ? authoredEndUs : durationUs,
        frameRateNum,
        frameRateDen,
      };
    },
    {
      activeKey: ACTIVE_PROJECT_KEY,
      timelineKey: TIMELINE_LOG_KEY,
      visualKey: 'joy-media.visual-object-project-log.v1',
    },
  );
}

/** Run `ffprobe` with a bounded argv. Errors are surfaced to the caller; this
 *  helper does NOT swallow them. */
function probeExport(path: string): {
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly frames: number;
  readonly timestampCount: number;
  readonly frameRate: string;
  readonly audioCodec?: string;
  readonly audioSampleRate?: number;
  readonly audioDuration?: number;
  readonly audioStartSeconds?: number;
  readonly videoStartSeconds?: number;
  readonly avDriftSeconds?: number;
  readonly ptsMonotonic: boolean;
  readonly syncEvents: ReadonlyArray<{
    readonly fraction: number;
    readonly videoPtsSeconds: number;
    readonly audioPtsSeconds: number;
    readonly driftSeconds: number;
  }>;
} {
  const raw = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-count_frames',
      '-show_entries',
      'format=format_name,duration:stream=codec_type,codec_name,width,height,nb_read_frames,sample_rate,duration,r_frame_rate,start_time',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(raw) as {
    readonly format?: { readonly format_name?: string; readonly duration?: string };
    readonly streams?: readonly {
      readonly codec_type?: string;
      readonly codec_name?: string;
      readonly width?: number;
      readonly height?: number;
      readonly nb_read_frames?: string;
      readonly sample_rate?: string;
      readonly duration?: string;
      readonly r_frame_rate?: string;
      readonly start_time?: string;
    }[];
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  const pts = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'frame=best_effort_timestamp_time',
        '-of',
        'json',
        path,
      ],
      { encoding: 'utf8' },
    ),
  ) as { readonly frames?: readonly { readonly best_effort_timestamp_time?: string }[] };
  const timestamps = (pts.frames ?? [])
    .map((frame) => Number(frame.best_effort_timestamp_time))
    .filter((value) => Number.isFinite(value));

  // Per-stream packet PTS — used for the multi-event A/V sync accounting.
  const videoPackets = probePacketTimestamps(path, 'v:0');
  const audioPackets = probePacketTimestamps(path, 'a:0');
  const formatDuration = Number(parsed.format?.duration ?? 0);
  const syncEvents = computeSyncEvents(
    videoPackets,
    audioPackets,
    formatDuration,
    SYNC_SAMPLE_FRACTIONS,
  );

  return {
    format: parsed.format?.format_name ?? '',
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    duration: formatDuration,
    frames: Number(video?.nb_read_frames ?? timestamps.length),
    timestampCount: timestamps.length,
    frameRate: video?.r_frame_rate ?? '',
    ...(audio?.codec_name === undefined ? {} : { audioCodec: audio.codec_name }),
    ...(audio?.sample_rate === undefined ? {} : { audioSampleRate: Number(audio.sample_rate) }),
    ...(audio?.duration === undefined ? {} : { audioDuration: Number(audio.duration) }),
    ...(video?.start_time === undefined ? {} : { videoStartSeconds: Number(video.start_time) }),
    ...(audio?.start_time === undefined ? {} : { audioStartSeconds: Number(audio.start_time) }),
    ...(audio?.duration === undefined
      ? {}
      : {
          avDriftSeconds: Math.abs(Number(audio.duration) - formatDuration),
        }),
    ptsMonotonic: timestamps.every(
      (value, index) => index === 0 || value >= timestamps[index - 1]!,
    ),
    syncEvents,
  };
}

/** Probe best-effort timestamp values for a single stream. Output is sorted
 *  ascending and clipped to a few hundred samples — the calling code only
 *  needs representative early/mid/late readings, not the full packet log. */
function probePacketTimestamps(path: string, stream: 'v:0' | 'a:0'): readonly number[] {
  const raw = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      stream,
      '-show_entries',
      'packet=pts_time,best_effort_timestamp_time',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(raw) as {
    readonly packets?: readonly {
      readonly pts_time?: string;
      readonly best_effort_timestamp_time?: string;
    }[];
  };
  return (parsed.packets ?? [])
    .map((p) => Number(p.best_effort_timestamp_time ?? p.pts_time))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}

/** Build early/mid/late sync events from per-stream packet timestamps. The
 *  drift reported is `|videoPts - (audioPts + aacPreRoll)|` — i.e. it
 *  subtracts the standard AAC encoder pre-roll so that the metric measures
 *  timeline-vs-encoder alignment, not encoder pre-roll vs pipeline.
 *
 *  The sample is taken at SYNC_EARLY_FRAME for the early fraction (so the
 *  sample is outside the very first GOP where libx264 emits dense I/P frames
 *  with quantized PTS) and at the requested fractions thereafter. */
function computeSyncEvents(
  videoPackets: readonly number[],
  audioPackets: readonly number[],
  formatDuration: number,
  fractions: readonly number[],
): ReadonlyArray<{
  readonly fraction: number;
  readonly videoPtsSeconds: number;
  readonly audioPtsSeconds: number;
  readonly driftSeconds: number;
}> {
  if (videoPackets.length === 0 || audioPackets.length === 0) return [];
  const events: Array<{
    fraction: number;
    videoPtsSeconds: number;
    audioPtsSeconds: number;
    driftSeconds: number;
  }> = [];
  for (const fraction of fractions) {
    const target =
      fraction <= 0.1
        ? videoPackets[Math.min(SYNC_EARLY_FRAME, videoPackets.length - 1)]!
        : videoPackets[
            Math.min(Math.floor(videoPackets.length * fraction), videoPackets.length - 1)
          ]!;
    // Find the audio packet nearest to the same target on the corrected
    // timeline (subtract pre-roll before comparing).
    const correctedTarget = target + AAC_PREROLL_S;
    let nearest = audioPackets[0]!;
    let bestDelta = Math.abs(nearest - correctedTarget);
    for (const audioPts of audioPackets) {
      const delta = Math.abs(audioPts - correctedTarget);
      if (delta < bestDelta) {
        bestDelta = delta;
        nearest = audioPts;
      }
    }
    events.push({
      fraction,
      videoPtsSeconds: target,
      audioPtsSeconds: nearest,
      driftSeconds: Math.abs(target - (nearest - AAC_PREROLL_S)),
    });
  }
  void formatDuration;
  return events;
}

/** Decode one frame at `time` to PPM and read the raw bytes to compute a
 *  cheap motion + content check. This intentionally avoids ImageMagick: the
 *  P3 acceptance test must run with only `ffprobe` + `ffmpeg` available on
 *  the self-hosted runner, and the PPM byte statistics are enough to
 *  distinguish a solid-black frame from a rendered Look-pack frame. */
function decodePixelStats(
  path: string,
  timeSeconds: number,
): {
  readonly meanLuma: number;
  readonly distinctLumaBuckets: number;
  readonly nonBlackFraction: number;
  readonly tileLuma: readonly number[];
} {
  const buffer = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-ss',
      String(timeSeconds),
      '-i',
      path,
      '-frames:v',
      '1',
      '-f',
      'image2',
      '-vcodec',
      'ppm',
      '-',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      // A full-resolution PPM frame is several MiB; Node's 1 MiB default
      // maxBuffer would turn a valid ffmpeg decode into ENOBUFS.
      maxBuffer: 32 * 1024 * 1024,
    },
  ) as Buffer;
  // PPM header is "P6\n<width> <height>\n<max>\n" then binary RGB. Parse it.
  const headerEnd = (() => {
    let i = 0;
    let newlinesSeen = 0;
    while (i < buffer.length && newlinesSeen < 3) {
      const byte = buffer[i]!;
      if (byte === 0x0a) newlinesSeen += 1;
      i += 1;
    }
    return i;
  })();
  const header = buffer.subarray(0, headerEnd).toString('ascii');
  const sizeMatch = /^P6\n(\d+) (\d+)\n(\d+)\n/.exec(header);
  if (sizeMatch === null) throw new Error(`unparseable PPM header: ${header.slice(0, 80)}`);
  const width = Number(sizeMatch[1]);
  const height = Number(sizeMatch[2]);
  const totalPixels = width * height;
  if (totalPixels === 0) throw new Error(`PPM reports zero pixels (${width}x${height})`);
  const pixels = buffer.subarray(headerEnd);
  let sumLuma = 0;
  let nonBlack = 0;
  const bucketSet = new Set<number>();
  const tileSums = Array.from({ length: 16 }, () => 0);
  const tileCounts = Array.from({ length: 16 }, () => 0);
  // Sample every Nth pixel to keep this fast (full 1920x1080 = 6 MB scan
  // would dominate the test budget).
  const step = Math.max(1, Math.floor(pixels.length / (64 * 1024)));
  let sampled = 0;
  for (let i = 0; i + 2 < pixels.length; i += 3 * step) {
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    sumLuma += luma;
    sampled += 1;
    const bucket = Math.min(31, Math.floor(luma / 8));
    bucketSet.add(bucket);
    if (luma >= 8) nonBlack += 1;
    const pixelNumber = Math.floor(i / 3);
    const tileX = Math.min(3, Math.floor(((pixelNumber % width) / width) * 4));
    const tileY = Math.min(3, Math.floor((Math.floor(pixelNumber / width) / height) * 4));
    const tile = tileY * 4 + tileX;
    tileSums[tile] += luma;
    tileCounts[tile] += 1;
  }
  return {
    meanLuma: sampled === 0 ? 0 : sumLuma / sampled,
    distinctLumaBuckets: bucketSet.size,
    nonBlackFraction: sampled === 0 ? 0 : nonBlack / sampled,
    tileLuma: tileSums.map((sum, index) => (tileCounts[index] === 0 ? 0 : sum / tileCounts[index])),
  };
}

async function downloadBytes(
  download: Download,
): Promise<{ readonly bytes: number; readonly path: string }> {
  const stream = await download.createReadStream();
  if (stream === null) throw new Error('download stream unavailable');
  let bytes = 0;
  for await (const chunk of stream) bytes += Buffer.byteLength(chunk);
  const path = await download.path();
  if (path === null) throw new Error('download path unavailable');
  return { bytes, path };
}

async function choosePreset(page: Page, preset: ExportPreset): Promise<void> {
  await page.getByRole('button', { name: 'Export preset', exact: true }).click();
  await page.getByRole('button', { name: preset.label, exact: true }).click();
}

async function applyLook(page: Page, pack: LookPack): Promise<void> {
  await openPanel(page, 'Joy Code');
  await page.getByRole('button', { name: 'Looks', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Living Looks' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(pack.title, { exact: true })).toBeVisible();
  const selectButton = panel.locator('.living-look-select').filter({ hasText: pack.title });
  await selectButton.click();
  const editor = panel.getByRole('form', { name: new RegExp(`${pack.title} controls`) });
  await expect(editor).toBeVisible();
  for (const slot of await editor.locator('.living-look-slot').all()) {
    const label = await slot.innerText();
    if (!label.includes('*')) continue;
    const select = slot.locator('select');
    if ((await select.locator('option').count()) < 2) {
      throw new Error(`${pack.id}: no bindable entity for ${await slot.innerText()}`);
    }
    const textOption = await select.locator('option').evaluateAll((options, content) => {
      const match = options.find(
        (option) => option.value.length > 0 && option.textContent?.includes(content),
      );
      return match?.value ?? null;
    }, P3_TEXT_FIXTURE_CONTENT);
    if (textOption === null) {
      throw new Error(
        `${pack.id}: required ${label.replace(/\s+\*\s*$/, '')} slot has no text visual object`,
      );
    }
    await select.selectOption(textOption);
  }
  const run =
    pack.id === 'music-pulse'
      ? editor.getByRole('button', { name: 'Run with motion baked from composition audio' })
      : editor.getByRole('button', { name: `Run ${pack.title}` });
  await expect(run).toBeEnabled();
  await run.click();
  const preview = page.getByRole('region', { name: 'JOY Agent live proposal' });
  await expect(preview).toHaveAttribute('data-agent-preview-ready', 'true', { timeout: 30_000 });
  await preview.getByRole('button', { name: /Approve & apply/ }).click();
  if (pack.id === 'music-pulse') {
    const panel = page.getByRole('region', { name: 'Living Looks' });
    await panel.getByRole('button', { name: /Activity/ }).click();
    await expect(
      page.getByText(
        /Baked \d+ audio-reactive track\(s\) from the composition beat(?: \(confidence \d+%\))?\./,
      ),
    ).toBeVisible({
      timeout: 30_000,
    });
  }
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled({
    timeout: 20_000,
  });
  await page
    .getByRole('region', { name: 'Living Looks' })
    .getByRole('tab', { name: 'Applied', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Applied Looks' }).getByText(pack.title, { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
}

interface GalleryEntry {
  readonly caseId: string;
  readonly pack: string;
  readonly preset: string;
  readonly kind: CaseKind;
  readonly mp4: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly frames: ReadonlyArray<{
    readonly fraction: number;
    readonly path: string;
    readonly sha256: string;
    readonly meanLuma: number;
    readonly nonBlackFraction: number;
  }>;
}

async function copyGalleryAssets(
  caseId: string,
  pack: string,
  preset: string,
  kind: CaseKind,
  downloadedPath: string,
  durationSeconds: number,
  width: number,
  height: number,
): Promise<GalleryEntry> {
  const caseDir = join(GALLERY_ROOT, caseId.replaceAll('/', '__'));
  await mkdir(caseDir, { recursive: true });
  const targetMp4 = join(caseDir, 'export.mp4');
  const caseRoot = resolve(caseDir);
  const assertInsideCase = (candidate: string): void => {
    const candidateRoot = resolve(candidate);
    const rel = relative(caseRoot, candidateRoot);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
      throw new Error(`gallery path escapes case directory: ${candidate}`);
  };
  assertInsideCase(targetMp4);
  await copyFile(downloadedPath, targetMp4);
  const mp4Buffer = await readFile(targetMp4);
  const mp4Bytes = mp4Buffer.byteLength;
  const sha256 = createHash('sha256').update(mp4Buffer).digest('hex');
  const frameEntries: GalleryEntry['frames'][number][] = [];
  for (const fraction of SYNC_SAMPLE_FRACTIONS) {
    const t = Math.min(
      Math.max(0, durationSeconds * fraction),
      Math.max(0, durationSeconds - 0.05),
    );
    if (!Number.isFinite(t) || t <= 0) continue;
    try {
      const stats = decodePixelStats(targetMp4, t);
      const framePath = join(caseDir, `frame-${fraction.toFixed(2)}.ppm`);
      assertInsideCase(framePath);
      // Re-decode so the saved frame is byte-identical to the analyzed one.
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-nostdin',
          '-y',
          '-ss',
          String(t),
          '-i',
          targetMp4,
          '-frames:v',
          '1',
          '-f',
          'image2',
          '-vcodec',
          'ppm',
          framePath,
        ],
        { encoding: 'utf8' },
      );
      frameEntries.push({
        fraction,
        path: framePath,
        sha256: createHash('sha256')
          .update(await readFile(framePath))
          .digest('hex'),
        meanLuma: stats.meanLuma,
        nonBlackFraction: stats.nonBlackFraction,
      });
    } catch (error) {
      // Save the error in evidence; do NOT silently drop a frame probe — it
      // would weaken the matrix and let a corrupted MP4 pass.
      throw new Error(
        `frame extraction failed at fraction ${fraction} (${t.toFixed(3)}s): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return {
    caseId,
    pack,
    preset,
    kind,
    mp4: targetMp4,
    sha256,
    bytes: mp4Bytes,
    width,
    height,
    frames: frameEntries,
  };
}

interface CaseEvidenceHolder {
  aggregate: P3CaseEvidenceAggregate;
}

interface RunExportCaseInputBase {
  readonly page: Page;
  readonly testInfo: TestInfo;
  readonly pack: LookPack;
  readonly preset: ExportPreset;
  readonly matrix: P3MatrixRow[];
  readonly projectIds: Set<string>;
  readonly failures: string[];
  readonly persistMatrix: () => Promise<void>;
  readonly caseEvidence: CaseEvidenceHolder;
  readonly persistCaseEvidence: () => Promise<void>;
}
// The export case pushes gallery entries as it produces downloads; the
// cancel case has nothing to add. Splitting the optional field off lets
// tsc flag the call sites correctly without a runtime check.
interface RunExportCaseInput extends RunExportCaseInputBase {
  readonly gallery: GalleryEntry[];
}
type RunCancelCaseInput = RunExportCaseInputBase;

async function runExportCase({
  page,
  testInfo,
  pack,
  preset,
  gallery,
  matrix,
  projectIds,
  failures,
  persistMatrix,
  caseEvidence,
  persistCaseEvidence,
}: RunExportCaseInput): Promise<void> {
  const caseId = `${pack.id}/${preset.id}`;
  const evidence: Record<string, unknown> = {
    caseId,
    pack: pack.id,
    preset: preset.id,
    kind: 'export',
  };
  await writeP3Progress({ caseId, phase: 'case-started' });
  // Mark the case as started BEFORE arming listeners / clicking so an
  // interrupted run leaves a truthful FAIL-with-reason row instead of
  // being silently promoted to PASS by a later pass. `markStarted` returns
  // a NEW full matrix; reassign the whole array so the 20-row provenance
  // and atomic-persistence contract remains intact.
  matrix.splice(0, matrix.length, ...markStarted(matrix, caseId, 'arming observer'));
  await persistMatrix();
  // Mirror the started transition into the per-case evidence aggregate so
  // the durable bundle records the same intent. Reassign (immutable helper)
  // and persist atomically — a forced interruption here leaves a partial
  // aggregate with `phase: started, result: NOT RUN` rather than a torn file.
  caseEvidence.aggregate = setCaseStarted(caseEvidence.aggregate, caseId, 'arming observer');
  await persistCaseEvidence();
  let timedOut = false;
  let observer: ReturnType<typeof armExportObserver> | undefined;
  try {
    await returnToProjectSelector(page);
    await openDisposableWorkspace(
      page,
      p3CaseWorkspaceTitle({
        candidateSha: process.env.JOY_MEDIA_CI_CANDIDATE_SHA ?? 'local',
        runId: process.env.JOY_MEDIA_CI_RUN_ID ?? '0',
        runAttempt: process.env.JOY_MEDIA_CI_RUN_ATTEMPT ?? '0',
        pass: process.env.JOY_MEDIA_CI_LANE_PASS ?? '1',
        caseId,
      }),
    );
    const fixtureHashes: Record<string, string> = {
      'video.mp4': await hashFixture('video.mp4'),
    };
    const videoName = `p3-${pack.id}-${preset.id}.mp4`;
    await importMediaFixture(page, 'video.mp4', videoName);
    await page
      .locator('.asset-card', { hasText: videoName })
      .first()
      .getByRole('button', { name: `Add ${videoName} to timeline` })
      .click();
    await addP3TextFixture(page);
    if (pack.id === 'music-pulse') {
      fixtureHashes['audio.wav'] = await hashFixture('audio.wav');
      const audioName = `p3-${pack.id}-${preset.id}.wav`;
      await importMediaFixture(page, 'audio.wav', audioName);
      await page
        .locator('.asset-card', { hasText: audioName })
        .first()
        .getByRole('button', { name: `Add ${audioName} to timeline` })
        .click();
    }
    await applyLook(page, pack);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openPanel(page, 'Joy Code');
    await page.getByRole('button', { name: 'Looks', exact: true }).click();
    await page
      .getByRole('region', { name: 'Living Looks' })
      .getByRole('tab', { name: 'Applied', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Applied Looks' }).getByText(pack.title, { exact: true }),
    ).toBeVisible();
    await choosePreset(page, preset);
    const projectBefore = await readEffectiveProjectState(page);
    if (projectIds.has(projectBefore.projectId))
      throw new Error(`P3 case reused persisted project ${projectBefore.projectId}`);
    projectIds.add(projectBefore.projectId);
    evidence.fixtureHashes = fixtureHashes;
    evidence.projectBefore = projectBefore;

    // --- Arm observers BEFORE the click so a fast export that fires
    //     synchronously with the click cannot be missed. ---
    const exportButton = page.getByRole('button', { name: 'Export MP4' });
    observer = armExportObserver(page, EXPORT_TIMEOUT_MS);
    await writeP3Progress({ caseId, phase: 'export-observer-armed' });
    let clickError: unknown;
    try {
      await exportButton.click();
    } catch (error) {
      clickError = error;
      // Preserve the real click error — DO NOT silently let it time out
      // for the full 35-minute window.
      observer.settle({ kind: 'click-error', error });
    }
    if (clickError !== undefined) {
      throw new Error(
        `Export MP4 click failed: ${clickError instanceof Error ? clickError.message : String(clickError)}`,
      );
    }
    const observation = await observer.promise;
    observer = undefined; // dispose is complete; do not double-settle in finally
    if (observation.kind === 'click-error') {
      throw new Error(
        `Export MP4 click failed: ${observation.error instanceof Error ? observation.error.message : String(observation.error)}`,
      );
    }
    if (observation.kind === 'page-closed') {
      throw new Error('Browser page closed during export — observer did not catch a download');
    }
    if (observation.kind === 'timeout') {
      timedOut = true;
      // Try to cancel so the project is left clean for the next case; if
      // the cancel button has already disappeared (export completed in the
      // last ms before the timeout fired) that's fine.
      await page
        .getByRole('button', { name: 'Cancel export' })
        .click({ timeout: 1000, trial: false })
        .catch(() => undefined);
      const why = observation.firstError ?? `no terminal event within ${EXPORT_TIMEOUT_MS}ms`;
      throw new Error(`export download timed out: ${why}`);
    }
    const downloaded = await downloadBytes(observation.download);
    evidence.bytes = downloaded.bytes;
    expect(downloaded.bytes).toBeGreaterThan(0);
    const probe = probeExport(downloaded.path);
    expect(probe.format.split(',')).toContain('mp4');
    const resolutionCheck = validateIntendedResolution(probe, preset);
    evidence.resolutionCheck = resolutionCheck;
    if (!resolutionCheck.ok)
      throw new Error(`intended resolution failed: ${resolutionCheck.problems.join(', ')}`);
    expect(probe.frames).toBeGreaterThan(0);
    expect(probe.timestampCount).toBe(probe.frames);
    expect(probe.frameRate).toBe('30/1');
    expect(probe.ptsMonotonic).toBe(true);
    const projectAfter = await readEffectiveProjectState(page);
    expectProjectUnchanged(projectBefore, projectAfter);
    evidence.projectAfter = projectAfter;

    // --- Tie expected frame count + duration to the persisted project ---
    const projectTimeline = await readProjectTimeline(page);
    if (projectTimeline !== null) {
      const expectedFrames = expectedPresentationFrameCount(projectTimeline);
      const drift = Math.abs(probe.duration - projectTimeline.durationUs / 1_000_000);
      evidence.expectedDurationSeconds = projectTimeline.durationUs / 1_000_000;
      evidence.expectedFrameCount = expectedFrames;
      evidence.expectedFrameRate = `${projectTimeline.frameRateNum}/${projectTimeline.frameRateDen}`;
      evidence.actualDurationSeconds = probe.duration;
      evidence.actualFrameCount = probe.frames;
      evidence.durationDriftSeconds = drift;
      // The container's over-run must be subtracted before comparing: the
      // timeline says 3.0s, but a concat path leaves ~21ms of container tail.
      expect(drift).toBeLessThanOrEqual(CONTAINER_OVERRUN_S + SYNC_DRIFT_BUDGET_S);
      const frameCheck = compareExactFrameCount(probe.frames, expectedFrames);
      if (!frameCheck.ok) throw new Error(frameCheck.reason);
    } else {
      evidence.expectedTimeline = null;
      throw new Error(
        'persisted timeline log missing or malformed; cannot tie expected duration to project',
      );
    }

    // --- Multi-event A/V sync accounting ---
    if (
      probe.audioCodec !== undefined &&
      probe.syncEvents.length === SYNC_SAMPLE_FRACTIONS.length
    ) {
      const driftViolations = probe.syncEvents.filter(
        (event) => event.driftSeconds > SYNC_DRIFT_BUDGET_S,
      );
      evidence.syncEvents = probe.syncEvents;
      evidence.syncDriftBudgetSeconds = SYNC_DRIFT_BUDGET_S;
      if (driftViolations.length > 0) {
        throw new Error(
          `A/V drift exceeded ${SYNC_DRIFT_BUDGET_S}s on ${driftViolations.length} sync event(s): ${driftViolations
            .map(
              (event) => `${(event.fraction * 100).toFixed(0)}%=${event.driftSeconds.toFixed(4)}s`,
            )
            .join(', ')}`,
        );
      }
    }

    // --- Per-pack content checks ---
    if (probe.avDriftSeconds !== undefined) expect(probe.avDriftSeconds).toBeLessThanOrEqual(0.1);

    // --- Music Pulse bake provenance ---
    if (pack.id === 'music-pulse') {
      expect(probe.audioCodec).toBe('aac');
      expect(probe.audioSampleRate).toBe(48_000);
      expect(probe.audioDuration).toBeGreaterThan(0);
      evidence.audioBakeProvenance = {
        audioCodec: probe.audioCodec,
        audioSampleRate: probe.audioSampleRate,
        audioDurationSeconds: probe.audioDuration,
        audioStartSeconds: probe.audioStartSeconds,
        aacPrerollSeconds: AAC_PREROLL_S,
        videoStartSeconds: probe.videoStartSeconds,
        codecDelayBudgetSeconds: SYNC_DRIFT_BUDGET_S,
        bakeKind: 'real-baked-audio',
      };
    } else {
      evidence.audioBakeProvenance = { bakeKind: 'not-applicable' };
    }

    // --- Decoded pixel + motion checks ---
    const sampleTimes = SYNC_SAMPLE_FRACTIONS.map((fraction) =>
      Math.min(Math.max(0, probe.duration * fraction), Math.max(0, probe.duration - 0.05)),
    );
    const pixelSamples = sampleTimes.map((time, index) => {
      const stats = decodePixelStats(downloaded.path, time);
      return { fraction: SYNC_SAMPLE_FRACTIONS[index]!, time, stats };
    });
    // Every sampled frame must have a meaningful fraction of non-black pixels
    // (>=1%) — a solid-black frame would prove the look didn't render.
    const blankFrames = pixelSamples.filter((sample) => sample.stats.nonBlackFraction < 0.01);
    evidence.pixelSamples = pixelSamples;
    if (blankFrames.length > 0) {
      throw new Error(
        `${blankFrames.length}/${pixelSamples.length} decoded frame(s) were >=99% black: ${blankFrames
          .map(
            (sample) =>
              `${(sample.fraction * 100).toFixed(0)}% meanLuma=${sample.stats.meanLuma.toFixed(1)}`,
          )
          .join(', ')}`,
      );
    }
    // Motion check: at least one pair of sampled frames must differ in mean
    // luma by >1.0 — proves something is moving across the timeline.
    const lumaRange = pixelSamples.reduce(
      (range, sample) => ({
        min: Math.min(range.min, sample.stats.meanLuma),
        max: Math.max(range.max, sample.stats.meanLuma),
      }),
      { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
    );
    evidence.lumaRange = lumaRange;
    if (lumaRange.max - lumaRange.min < 1.0) {
      throw new Error(
        `decoded frames show <1.0 mean-luma range across samples (min=${lumaRange.min.toFixed(2)}, max=${lumaRange.max.toFixed(2)}) — no motion detected`,
      );
    }
    const spatialCheck = validateDecodedPixelSamples(pixelSamples);
    evidence.spatialPixelCheck = spatialCheck;
    if (!spatialCheck.ok) {
      throw new Error(`decoded spatial Look evidence failed: ${spatialCheck.problems.join(', ')}`);
    }

    await expect(page.getByRole('button', { name: 'Cancel export' })).toHaveCount(0);

    // --- Retain MP4 + representative frames in evidence gallery ---
    const galleryEntry = await copyGalleryAssets(
      caseId,
      pack.id,
      preset.id,
      'export',
      downloaded.path,
      probe.duration,
      probe.width,
      probe.height,
    );
    gallery.push(galleryEntry);
    evidence.galleryEntry = {
      mp4: galleryEntry.mp4,
      sha256: galleryEntry.sha256,
      bytes: galleryEntry.bytes,
      width: galleryEntry.width,
      height: galleryEntry.height,
      frameCount: galleryEntry.frames.length,
    };
    evidence.bytes = downloaded.bytes;
    evidence.ffprobe = probe;
    evidence.result = 'PASS';
  } catch (error) {
    evidence.result = 'FAIL';
    evidence.error = error instanceof Error ? error.message : String(error);
    failures.push(`${caseId}: ${String(evidence.error)}`);
  } finally {
    // Best-effort late disposal — if the await above resolved and we already
    // nulled the observer, this is a no-op. settle() is idempotent.
    observer?.settle({ kind: 'timeout', firstError: null });
    const finalResult = (evidence.result === 'PASS' ? 'PASS' : 'FAIL') as 'PASS' | 'FAIL';
    await writeP3Progress({ caseId, phase: 'case-finished', result: finalResult });
    matrix.splice(
      0,
      matrix.length,
      ...markResult(matrix, caseId, finalResult, String(evidence.error ?? '')),
    );
    await persistMatrix();
    // Persist the rich per-case evidence into the durable aggregate so the
    // retained bundle carries projectBefore / projectAfter / persisted timeline
    // expectations / ffprobe / sync events / pixel samples / spatial checks /
    // gallery entry alongside the matrix verdict. Same atomic write shape as
    // `persistMatrix`.
    caseEvidence.aggregate = setCaseFinished(
      caseEvidence.aggregate,
      caseId,
      finalResult,
      evidence,
      evidence.error === undefined ? null : String(evidence.error),
    );
    await persistCaseEvidence();
    await testInfo.attach(`${caseId.replaceAll('/', '-')}.json`, {
      body: Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`),
      contentType: 'application/json',
    });
  }
  if (timedOut) throw new Error('export download timed out (re-thrown after teardown)');
}
async function runCancelCase({
  page,
  testInfo,
  pack,
  preset,
  failures,
  matrix,
  projectIds,
  persistMatrix,
  caseEvidence,
  persistCaseEvidence,
}: RunCancelCaseInput): Promise<void> {
  const caseId = `cancel/${pack.id}/${preset.id}`;
  const evidence: Record<string, unknown> = {
    caseId,
    pack: pack.id,
    preset: preset.id,
    kind: 'cancel',
  };
  await writeP3Progress({ caseId, phase: 'case-started' });
  // Mark the cancel case as started before clicking so an interrupted run
  // cannot leave it silently NOT RUN while the matrix says it should have
  // produced terminal evidence. `markStarted` returns a NEW full matrix;
  // reassign the whole array so 20-row provenance + atomic persistence are
  // preserved.
  matrix.splice(0, matrix.length, ...markStarted(matrix, caseId, 'arming cancel observer'));
  await persistMatrix();
  // Same intent for the per-case evidence aggregate — atomic persistence keeps
  // the durable bundle in lockstep with the matrix.
  caseEvidence.aggregate = setCaseStarted(caseEvidence.aggregate, caseId, 'arming cancel observer');
  await persistCaseEvidence();
  // Held in the outer scope so the finally can dispose listeners/timers on
  // any path (success, click failure, cancel click failure, assertion fail).
  let observer: ReturnType<typeof armExportObserver> | undefined;
  try {
    await returnToProjectSelector(page);
    await openDisposableWorkspace(
      page,
      p3CaseWorkspaceTitle({
        candidateSha: process.env.JOY_MEDIA_CI_CANDIDATE_SHA ?? 'local',
        runId: process.env.JOY_MEDIA_CI_RUN_ID ?? '0',
        runAttempt: process.env.JOY_MEDIA_CI_RUN_ATTEMPT ?? '0',
        pass: process.env.JOY_MEDIA_CI_LANE_PASS ?? '1',
        caseId,
      }),
    );
    const fixtureHashes: Record<string, string> = {
      'video.mp4': await hashFixture('video.mp4'),
    };
    const videoName = `p3-cancel-${pack.id}-${preset.id}.mp4`;
    await importMediaFixture(page, 'video.mp4', videoName);
    await page
      .locator('.asset-card', { hasText: videoName })
      .first()
      .getByRole('button', { name: `Add ${videoName} to timeline` })
      .click();
    await addP3TextFixture(page);
    if (pack.id === 'music-pulse') {
      fixtureHashes['audio.wav'] = await hashFixture('audio.wav');
      const audioName = `p3-cancel-${pack.id}-${preset.id}.wav`;
      await importMediaFixture(page, 'audio.wav', audioName);
      await page
        .locator('.asset-card', { hasText: audioName })
        .first()
        .getByRole('button', { name: `Add ${audioName} to timeline` })
        .click();
    }
    await applyLook(page, pack);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openPanel(page, 'Joy Code');
    await page.getByRole('button', { name: 'Looks', exact: true }).click();
    await page
      .getByRole('region', { name: 'Living Looks' })
      .getByRole('tab', { name: 'Applied', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Applied Looks' }).getByText(pack.title, { exact: true }),
    ).toBeVisible();
    await choosePreset(page, preset);
    const projectBefore = await readEffectiveProjectState(page);
    if (projectIds.has(projectBefore.projectId))
      throw new Error(`P3 case reused persisted project ${projectBefore.projectId}`);
    projectIds.add(projectBefore.projectId);
    evidence.fixtureHashes = fixtureHashes;
    evidence.projectBefore = projectBefore;

    // --- Arm the cancel observer BEFORE clicking Export MP4. The click can
    //     throw immediately (pageerror, console error, navigation, detached
    //     button) — settle() must dispose listeners/timers exactly once and
    //     the case MUST fail promptly so we never sit through the long
    //     export timeout behind a missed click. ---
    const exportButton = page.getByRole('button', { name: 'Export MP4' });
    observer = armExportObserver(page, EXPORT_TIMEOUT_MS);
    await writeP3Progress({ caseId, phase: 'cancel-observer-armed' });
    let clickError: unknown;
    try {
      await exportButton.click();
    } catch (error) {
      clickError = error;
      observer.settle({ kind: 'click-error', error });
    }
    if (clickError !== undefined) {
      throw new Error(
        `Export MP4 click failed: ${clickError instanceof Error ? clickError.message : String(clickError)}`,
      );
    }
    const cancel = page.getByRole('button', { name: 'Cancel export' });
    await expect(cancel).toBeVisible({ timeout: 60_000 });
    let cancelClickError: unknown;
    try {
      await cancel.click();
      observer.settle({ kind: 'page-closed' });
    } catch (error) {
      cancelClickError = error;
      observer.settle({ kind: 'click-error', error });
    }
    if (cancelClickError !== undefined) {
      throw new Error(
        `Cancel export click failed: ${cancelClickError instanceof Error ? cancelClickError.message : String(cancelClickError)}`,
      );
    }
    // The cancel path MUST land on the retryable process row, not a stuck
    // "running" state — verify the cancellation is terminal.
    await expect(
      page.getByText('Export cancelled. You can retry from Recent processes.'),
    ).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Recent processes', exact: true }).click();
    const cancelled = page.locator('.process-row.process-interrupted-retryable');
    await expect(cancelled).toHaveCount(1, { timeout: 30_000 });
    // Cleanup assertion: no half-written export row remains with an
    // "active" state after the cancel — the project is left in a state
    // where a fresh export could start.
    const residualActiveRows = await page.locator('.process-row.process-active').count();
    if (residualActiveRows !== 0) {
      throw new Error(
        `cancel left ${residualActiveRows} active process row(s) — project is not clean`,
      );
    }
    // Cleanup: dismiss the cancel notice so the next case can run cleanly.
    await expect(page.getByRole('button', { name: 'Cancel export' })).toHaveCount(0);
    const projectAfter = await readEffectiveProjectState(page);
    expectProjectUnchanged(projectBefore, projectAfter);
    evidence.projectAfter = projectAfter;
    await returnToProjectSelector(page);
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    evidence.cleanup = {
      cancelButtonVisible: false,
      cancelBannerVisible: true,
      retryableRowCount: 1,
      residualActiveRows,
      nextCaseSelectorVisible: true,
    };
    evidence.result = 'PASS';
  } catch (error) {
    evidence.result = 'FAIL';
    evidence.error = error instanceof Error ? error.message : String(error);
    failures.push(`${caseId}: ${String(evidence.error)}`);
  } finally {
    const finalResult = (evidence.result === 'PASS' ? 'PASS' : 'FAIL') as 'PASS' | 'FAIL';
    await writeP3Progress({ caseId, phase: 'case-finished', result: finalResult });
    matrix.splice(
      0,
      matrix.length,
      ...markResult(matrix, caseId, finalResult, String(evidence.error ?? '')),
    );
    await persistMatrix();
    // Persist the rich per-case evidence into the durable aggregate so the
    // retained bundle carries projectBefore / projectAfter / cleanup checks
    // alongside the matrix verdict. Same atomic write shape as `persistMatrix`.
    caseEvidence.aggregate = setCaseFinished(
      caseEvidence.aggregate,
      caseId,
      finalResult,
      evidence,
      evidence.error === undefined ? null : String(evidence.error),
    );
    await persistCaseEvidence();
    // Best-effort late disposal — if cancel clicks already settled the
    // observer, this is a no-op (settle() is idempotent).
    observer?.settle({ kind: 'page-closed' });
    await testInfo.attach(`${caseId.replaceAll('/', '-')}.json`, {
      body: Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`),
      contentType: 'application/json',
    });
  }
}

test.describe('JOY R2 P3 shipping browser export matrix', () => {
  test('exports every shipping Look pack in portrait and landscape after reopen', async ({
    page,
  }, testInfo) => {
    test.setTimeout(3_600_000);
    if (process.env.JOY_P3_REAL_EXPORTS !== '1') {
      testInfo.annotations.push({
        type: 'NOT RUN',
        description:
          'Set JOY_P3_REAL_EXPORTS=1 on a self-hosted runner with real export assets to execute the 20-case matrix (5 packs × 2 presets × export/cancel).',
      });
      return;
    }

    // --- Initialize the matrix BEFORE authentication / setup so an early
    //     failure (auth, webServer boot, etc.) leaves a truthful NOT RUN
    //     ledger. The harness validator rejects any row that is not PASS,
    //     so persistence is the only signal a downstream reader gets. ---
    const provenance = p3Provenance({
      candidateSha:
        process.env.JOY_MEDIA_CI_CANDIDATE_SHA ?? '0000000000000000000000000000000000000000',
      runId: process.env.JOY_MEDIA_CI_RUN_ID ?? '0',
      runAttempt: process.env.JOY_MEDIA_CI_RUN_ATTEMPT ?? '0',
      pass: process.env.JOY_MEDIA_CI_LANE_PASS ?? '1',
      issuedAt: new Date().toISOString(),
    });
    const matrix: P3MatrixRow[] = attachProvenance(newP3Matrix(), provenance);
    const persistMatrix = async (): Promise<void> => {
      await mkdir('test-output/browser', { recursive: true });
      const tmp = `${MATRIX_PATH}.tmp`;
      // Atomic write: write to a temp file and rename. A crashed write
      // never overwrites a previously-good matrix.
      await writeFile(tmp, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
      await rm(MATRIX_PATH, { force: true });
      const { rename } = await import('node:fs/promises');
      await rename(tmp, MATRIX_PATH);
    };
    await persistMatrix();
    // Per-case evidence aggregate. Initialize BEFORE authentication / setup so
    // an early failure (auth, webServer boot, etc.) leaves a truthful
    // `NOT RUN` ledger. The atomic persistence shape mirrors the matrix above
    // and is keyed to the same candidate/run/attempt/pass provenance.
    const caseEvidence: CaseEvidenceHolder = {
      aggregate: newP3CaseEvidence(provenance),
    };
    const persistCaseEvidence = async (): Promise<void> => {
      await mkdir('test-output/browser', { recursive: true });
      await persistP3CaseEvidence(caseEvidence.aggregate);
    };
    await persistCaseEvidence();
    await writeP3Progress({ phase: 'matrix-initialized' });

    const gallery: GalleryEntry[] = [];
    const projectIds = new Set<string>();
    const failures: string[] = [];

    // Always start with a clean gallery so old runs don't pollute evidence.
    await rm(GALLERY_ROOT, { recursive: true, force: true });
    await mkdir(GALLERY_ROOT, { recursive: true });

    try {
      await authenticate(page);
      for (const pack of LOOK_PACKS) {
        for (const preset of PRESETS) {
          await runExportCase({
            page,
            testInfo,
            pack,
            preset,
            gallery,
            matrix,
            projectIds,
            failures,
            persistMatrix,
            caseEvidence,
            persistCaseEvidence,
          });
        }
      }
      // Cancellation proof: one cancel case per pack × preset, after the
      // successful export matrix is recorded. These cases do not weaken any
      // existing assertion; they prove the cancel button removes the export
      // and leaves the project clean for retry.
      for (const pack of LOOK_PACKS) {
        for (const preset of PRESETS) {
          await runCancelCase({
            page,
            testInfo,
            pack,
            preset,
            failures,
            matrix,
            projectIds,
            persistMatrix,
            caseEvidence,
            persistCaseEvidence,
          });
        }
      }
    } finally {
      // Always persist the gallery manifest, even if a case threw — the
      // retention script must be able to find the gallery independently of
      // whether the test body reached its final assertion.
      const galleryManifest = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        entries: gallery,
      };
      await mkdir(dirname(GALLERY_MANIFEST_PATH), { recursive: true });
      await writeFile(
        GALLERY_MANIFEST_PATH,
        `${JSON.stringify(galleryManifest, null, 2)}\n`,
        'utf8',
      );
    }

    await testInfo.attach('p3-export-matrix.json', {
      body: Buffer.from(`${JSON.stringify(matrix, null, 2)}\n`),
      contentType: 'application/json',
    });
    await testInfo.attach('p3-export-gallery-manifest.json', {
      body: Buffer.from(
        `${JSON.stringify(
          {
            entries: gallery.map(
              ({ caseId, pack, preset, kind, sha256, bytes, width, height, mp4, frames }) => ({
                caseId,
                pack,
                preset,
                kind,
                sha256,
                bytes,
                width,
                height,
                mp4,
                frames,
              }),
            ),
          },
          null,
          2,
        )}\n`,
      ),
      contentType: 'application/json',
    });

    await writeP3Progress({
      phase: 'p3-complete',
      result: failures.length === 0 ? 'PASS' : 'FAIL',
    });
    expect(failures, `P3 export failures:\n${failures.join('\n')}`).toEqual([]);
  });
});
