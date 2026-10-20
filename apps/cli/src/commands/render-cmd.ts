/* global Atomics, SharedArrayBuffer, console, process, setImmediate */
/**
 * Headless batch render command.
 *
 * `joy render --project <id|file.json> --preset <mp4|webm|prores> --out <dir>`
 *
 * Two modes, chosen from the project:
 * - Real render: when the clips point at media files on this machine (added with
 *   `timeline add-clip --asset <file>`, or found via `--media-dir`), ffmpeg encodes
 *   `<out>/<projectId>.<ext>` and a manifest is written beside it (`mediaProduced: true`).
 * - Manifest only: when no clip has a media file (or with `--manifest-only`) it walks every
 *   clip of every enabled track and writes a *plan manifest* to
 *   `<out>/<projectId>.<ext>.manifest.json`. No media file is produced, and every human
 *   message and the final JSON event say so (`mediaProduced: false`).
 * - Nothing to encode: a real render of a project with no clips fails with
 *   `nothing-to-render` (exit 1). Only `--manifest-only` may succeed without media.
 *
 * Streams progress either as a progress bar (human mode, TTY only) or as
 * newline-delimited JSON events (`--json`). In `--json` mode stdout carries
 * ONLY events, and the last event is always `complete` (exit 0) or `error`
 * (exit non-zero).
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { CliFlags } from '../cli.js';
import { currentLongRunning, longRunningCancellationExitCode } from '../long-running.js';
import { FlagValidationError, parseIntFlag } from '../utils/flags.js';
import {
  c,
  logError,
  logInfo,
  logStep,
  logSuccess,
  logWarn,
  printBanner,
} from '../utils/logger.js';
import { CONTENT_TEMPLATES_PLUGIN_KEY, type TitleInstanceV1 } from '@joy-media/project-schema';
import { ffmpegBinary, probeMedia } from '../utils/media-probe.js';
import {
  renderTitleFrames,
  sha256Hex,
  titleRendererFacts,
  type TitleFrameSource,
} from '../services/title-frames.js';
import {
  buildFfmpegArgs,
  captionRenderMode,
  fileSize,
  planMedia,
  startEncode,
  type MediaPlanReady,
} from './render-media.js';
import { listProjects, loadProject, type CliProjectDocument } from '../utils/project-loader.js';

export interface RenderCommandFlags {
  project?: string | undefined;
  preset?: string | undefined;
  out?: string | undefined;
  concurrency?: number | undefined;
  json?: boolean | undefined;
  sqlitePath?: string | undefined;
  manifestOnly?: boolean | undefined;
  mediaDir?: string | undefined;
  frameUs?: number | undefined;
}

export interface RenderPresetSpec {
  readonly id: 'mp4' | 'webm' | 'prores';
  readonly container: string;
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly extension: string;
}

export const RENDER_PRESETS: Readonly<Record<RenderPresetSpec['id'], RenderPresetSpec>> = {
  mp4: {
    id: 'mp4',
    container: 'mp4',
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 1080,
    height: 1920,
    fps: 30,
    extension: 'mp4',
  },
  webm: {
    id: 'webm',
    container: 'webm',
    videoCodec: 'vp9',
    audioCodec: 'opus',
    width: 1080,
    height: 1920,
    fps: 30,
    extension: 'webm',
  },
  prores: {
    id: 'prores',
    container: 'mov',
    videoCodec: 'prores-ks',
    audioCodec: 'pcm-s24le',
    width: 1080,
    height: 1920,
    fps: 30,
    extension: 'mov',
  },
};

/** Same ceiling `timeline add-clip --duration` enforces (24 h). */
export const MAX_CLIP_DURATION_US = 86_400 * 1_000_000;

/** Frames processed between yields to the event loop (keeps SIGINT/SIGTERM responsive). */
const FRAMES_PER_SLICE = 262_144;

export const MANIFEST_ONLY_MESSAGE =
  'Manifest only - no video file written. This command records the render plan; it does not encode media.';
export const NOTHING_RENDERED_MESSAGE =
  'Nothing rendered - the project has no clips on enabled tracks. No manifest and no video file were written.';

export interface RenderClipEvent {
  readonly type: 'clip';
  readonly projectId: string;
  readonly trackId: string;
  readonly clipId: string;
  readonly progress: number;
  readonly framesRendered: number;
  readonly totalFrames: number;
}

export interface RenderTrackEvent {
  readonly type: 'track';
  readonly projectId: string;
  readonly trackId: string;
  readonly trackName: string;
  readonly clipCount: number;
}

export interface RenderStartEvent {
  readonly type: 'start';
  readonly projectId: string;
  readonly title: string;
  readonly preset: RenderPresetSpec['id'];
  readonly outDir: string;
  readonly totalFrames: number;
  readonly totalClips: number;
  readonly concurrency: number;
  readonly ts: string;
}

export interface RenderCompleteEvent {
  readonly type: 'complete';
  readonly projectId: string;
  readonly preset: RenderPresetSpec['id'];
  readonly outDir: string;
  readonly artifactPath: string;
  readonly totalFrames: number;
  readonly durationMs: number;
  readonly ts: string;
  /** `true` when a video file was encoded (`mediaPath`); `false` for a manifest-only run. */
  readonly mediaProduced: boolean;
  /** Real render only: the encoded video. */
  readonly mediaPath?: string;
  /** Real render only: the plan manifest written next to the video. */
  readonly manifestPath?: string;
  /** `true` when `artifactPath` points at a manifest that was written. */
  readonly manifestWritten: boolean;
  /** Human-readable statement of what was (and was not) produced. */
  readonly message: string;
  /** Non-fatal findings (skipped tracks, preset/project mismatch, ...). */
  readonly warnings: readonly string[];
}

export type RenderErrorCode =
  | 'usage'
  | 'project-load'
  | 'invalid-project'
  | 'output'
  | 'cancelled'
  | 'internal'
  | 'media-missing'
  | 'media-unreadable'
  | 'unsupported-feature'
  | 'ffmpeg-missing'
  | 'encode-failed'
  | 'nothing-to-render'
  | 'RANGE_ERROR'
  | 'SLICE_LIMIT';

/** Real render only: encoder progress, at most one event per whole percent. */
export interface RenderProgressEvent {
  readonly type: 'progress';
  readonly projectId: string;
  readonly percent: number;
  readonly ts: string;
}

export interface RenderErrorEvent {
  readonly type: 'error';
  readonly projectId: string;
  readonly message: string;
  readonly ts: string;
  /** Machine-readable failure category. */
  readonly code?: RenderErrorCode;
}

export interface RenderPreviewCompleteEvent {
  readonly schemaVersion: 1;
  readonly type: 'preview-complete';
  readonly projectId: string;
  readonly frameIndex: number;
  readonly timeUs: number;
  readonly width: number;
  readonly height: number;
  readonly artifactPath: string;
  readonly mediaProduced: true;
}

export type RenderEvent =
  | RenderStartEvent
  | RenderClipEvent
  | RenderTrackEvent
  | RenderProgressEvent
  | RenderCompleteEvent
  | RenderErrorEvent
  | RenderPreviewCompleteEvent;

export interface RenderCommandResult {
  readonly exitCode: number;
  readonly projectId: string;
  readonly preset: RenderPresetSpec['id'];
  readonly outDir: string;
  readonly artifactPath: string;
  readonly totalFrames: number;
  readonly totalClips: number;
  readonly durationMs: number;
  readonly mediaProduced: boolean;
  readonly mediaPath?: string;
  readonly manifestWritten: boolean;
  readonly warnings: readonly string[];
}

export async function handleRenderCommand(args: string[], flags: CliFlags): Promise<number> {
  void args;
  const json = Boolean(flags.json);
  const projectHint = flags.project ?? '';

  try {
    const presetRaw = (flags.preset ?? 'mp4').toLowerCase();
    if (!isRenderPresetId(presetRaw)) {
      return failCommand(
        json,
        projectHint,
        'usage',
        `Unknown render preset "${presetRaw}". Available: mp4, webm, prores.`,
        2,
      );
    }
    const preset = presetRaw as RenderPresetSpec['id'];

    const outDir = flags.out ?? './renders';
    if (outDir.trim() === '') {
      return failCommand(
        json,
        projectHint,
        'usage',
        '--out must be a directory path, but it was empty.',
        2,
      );
    }
    const concurrency =
      parseIntFlag('concurrency', flags.concurrency, {
        min: 1,
        max: 32,
        allowZero: false,
      }) ?? 2;

    if (!flags.project) {
      // Kept at exit 1 (pinned by render-cmd.test.ts); `timeline` behaves the same way.
      return failCommand(
        json,
        projectHint,
        'usage',
        'Please specify target project via --project <id|file.json>',
        1,
      );
    }

    let projectInfo;
    try {
      projectInfo = loadProject(flags.project, flags.sqlitePath);
    } catch (err) {
      return failCommand(
        json,
        flags.project,
        'project-load',
        `Cannot load project: ${errorMessage(err)}`,
        1,
      );
    }

    const result = await runHeadlessRender({
      project: projectInfo.project,
      preset,
      outDir,
      concurrency,
      json,
      manifestOnly: flags.manifestOnly === true,
      mediaDir: flags.mediaDir,
      frameUs: flags.frameUs,
    });

    return result.exitCode;
  } catch (err) {
    if (err instanceof FlagValidationError) {
      return failCommand(json, projectHint, 'usage', err.message, 2);
    }
    return failCommand(
      json,
      projectHint,
      'internal',
      `Render failed unexpectedly: ${errorMessage(err)}`,
      1,
    );
  }
}

export interface RunHeadlessRenderInput {
  readonly project: CliProjectDocument;
  readonly preset: RenderPresetSpec['id'];
  readonly outDir: string;
  readonly concurrency: number;
  readonly json: boolean;
  /** Skip ffmpeg and write only the plan manifest. */
  readonly manifestOnly?: boolean | undefined;
  /** Folder to look in for media files an asset names (by id or display name). */
  readonly mediaDir?: string | undefined;
  /** Render a single composed frame at this project-local microsecond. */
  readonly frameUs?: number | undefined;
  /**
   * Draw the live progress bar (human mode only). Defaults to "stdout is a
   * terminal" so piped/redirected output is never spammed with `\r` frames.
   */
  readonly progress?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Planning (pure, validates untrusted project documents)
// ---------------------------------------------------------------------------

export interface PlannedClip {
  readonly trackId: string;
  readonly trackName: string;
  readonly clipId: string;
  readonly startUs: number | null;
  readonly durationUs: number;
  readonly frames: number;
  /** Index of this clip's first frame in the render's sequential frame stream. */
  readonly firstFrame: number;
}

export interface PlanComposition {
  readonly id: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly fps: number | null;
  readonly durationUs: number | null;
}

export type RenderPlan =
  | {
      readonly ok: true;
      readonly projectId: string;
      readonly title: string;
      readonly composition: PlanComposition;
      readonly trackCount: number;
      readonly clips: readonly PlannedClip[];
      readonly totalFrames: number;
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** First output frame at or after a timeline timestamp for the selected FPS. */
function frameBoundaryAtUs(timeUs: number, fps: string): number {
  const [numeratorText, denominatorText] = fps.split('/');
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText ?? '1');
  if (!(numerator > 0) || !(denominator > 0)) return 0;
  return Math.max(0, Math.ceil((timeUs * numerator) / (1_000_000 * denominator) - 1e-9));
}

/**
 * Turn a (possibly hand-written or agent-generated) project document into an
 * ordered list of clips with frame counts. Never throws: structural problems
 * come back as `{ ok: false, message }` so the caller can report them cleanly.
 */
export function planRender(project: unknown, presetSpec: RenderPresetSpec): RenderPlan {
  if (!isRecord(project)) {
    return {
      ok: false,
      message: 'The project document is not a JOY Media project (expected a JSON object).',
    };
  }
  const projectId = project['id'];
  if (typeof projectId !== 'string' || projectId.trim() === '') {
    return {
      ok: false,
      message: 'The project document has no "id", so there is no safe name for the output files.',
    };
  }
  const compositions = project['compositions'];
  if (!isRecord(compositions)) {
    return { ok: false, message: `Project "${projectId}" has no "compositions" object.` };
  }
  const rootId = project['rootCompositionId'];
  const root = typeof rootId === 'string' ? compositions[rootId] : undefined;
  if (!isRecord(root)) {
    return {
      ok: false,
      message: `Project "${projectId}" has no root composition ${JSON.stringify(rootId)} (rootCompositionId does not match any composition).`,
    };
  }
  const rawTracks = root['tracks'] ?? [];
  if (!Array.isArray(rawTracks)) {
    return {
      ok: false,
      message: `Project "${projectId}": root composition "tracks" is not a list.`,
    };
  }

  const frameRate = isRecord(root['frameRate']) ? root['frameRate'] : undefined;
  const num = finiteOrNull(frameRate?.['num']);
  const den = finiteOrNull(frameRate?.['den']);
  const composition: PlanComposition = {
    id: String(rootId),
    width: finiteOrNull(root['width']),
    height: finiteOrNull(root['height']),
    fps: num !== null && den !== null && den > 0 ? num / den : null,
    durationUs: finiteOrNull(root['durationUs']),
  };

  const warnings: string[] = [];
  const clips: PlannedClip[] = [];
  let firstFrame = 0;
  // Where the last clip ends; the timeline is as long as its content when it has clips.
  let contentEndUs = 0;

  for (const [trackIndex, rawTrack] of rawTracks.entries()) {
    if (!isRecord(rawTrack) || typeof rawTrack['id'] !== 'string') {
      return {
        ok: false,
        message: `Project "${projectId}": track #${trackIndex + 1} is missing its "id".`,
      };
    }
    const trackId = rawTrack['id'];
    const trackName = typeof rawTrack['name'] === 'string' ? rawTrack['name'] : trackId;
    const rawClips = rawTrack['clips'] ?? [];
    if (!Array.isArray(rawClips)) {
      return {
        ok: false,
        message: `Project "${projectId}": track "${trackId}" has a "clips" value that is not a list.`,
      };
    }
    if (rawTrack['enabled'] === false) {
      // Same rule the evaluator uses: a disabled track contributes nothing.
      if (rawClips.length > 0) {
        warnings.push(`Skipped disabled track "${trackId}" (${rawClips.length} clip(s)).`);
      }
      continue;
    }
    for (const [clipIndex, rawClip] of rawClips.entries()) {
      if (!isRecord(rawClip) || typeof rawClip['id'] !== 'string') {
        return {
          ok: false,
          message: `Project "${projectId}": clip #${clipIndex + 1} on track "${trackId}" is missing its "id".`,
        };
      }
      const clipId = rawClip['id'];
      const durationUs = rawClip['durationUs'];
      if (
        typeof durationUs !== 'number' ||
        !Number.isFinite(durationUs) ||
        durationUs < 0 ||
        durationUs > MAX_CLIP_DURATION_US
      ) {
        return {
          ok: false,
          message:
            `Project "${projectId}": clip "${clipId}" on track "${trackId}" has an invalid ` +
            `durationUs (${JSON.stringify(durationUs)}); expected a number from 0 to ${MAX_CLIP_DURATION_US} (24 h).`,
        };
      }
      const frames = Math.max(1, Math.round((durationUs / 1_000_000) * presetSpec.fps));
      contentEndUs = Math.max(contentEndUs, (finiteOrNull(rawClip['startUs']) ?? 0) + durationUs);
      clips.push({
        trackId,
        trackName,
        clipId,
        startUs: finiteOrNull(rawClip['startUs']),
        durationUs,
        frames,
        firstFrame,
      });
      firstFrame += frames;
    }
  }

  const sizeDiffers =
    composition.width !== null &&
    composition.height !== null &&
    (composition.width !== presetSpec.width || composition.height !== presetSpec.height);
  const fpsDiffers = composition.fps !== null && Math.abs(composition.fps - presetSpec.fps) > 0.01;
  if (clips.length > 0 && (sizeDiffers || fpsDiffers)) {
    const fpsText = composition.fps === null ? '?' : String(Number(composition.fps.toFixed(3)));
    warnings.push(
      `Project composition is ${composition.width ?? '?'}x${composition.height ?? '?'} @ ${fpsText} fps, ` +
        `but preset "${presetSpec.id}" is fixed at ${presetSpec.width}x${presetSpec.height} @ ${presetSpec.fps} fps; ` +
        `frame counts use the preset rate.`,
    );
  }

  return {
    ok: true,
    projectId,
    title: typeof project['title'] === 'string' ? project['title'] : projectId,
    composition: {
      ...composition,
      durationUs: clips.length > 0 ? contentEndUs : composition.durationUs,
    },
    trackCount: rawTracks.length,
    clips,
    totalFrames: firstFrame,
    warnings,
  };
}

/** Make a project id safe to use as a file name (no separators, no leading dots). */
export function safeFileStem(id: string): string {
  const cleaned = id
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, (dots) => '_'.repeat(dots.length))
    .slice(0, 120);
  return cleaned === '' ? '_' : cleaned;
}

function collectTitleSources(project: CliProjectDocument): TitleFrameSource[] {
  const namespace = project.pluginData[CONTENT_TEMPLATES_PLUGIN_KEY] as
    { readonly instances?: Readonly<Record<string, TitleInstanceV1>> } | undefined;
  const instances = namespace?.instances;
  if (!instances || typeof instances !== 'object') return [];
  const compositions = project.compositions as Record<string, unknown>;
  const composition = compositions[project.rootCompositionId] as
    | {
        readonly tracks?: readonly {
          readonly id?: string;
          readonly kind?: string;
          readonly family?: string;
          readonly clips?: readonly Record<string, unknown>[];
        }[];
      }
    | undefined;
  const sources: Array<TitleFrameSource & { trackOrder: number }> = [];
  for (const [instanceId, instance] of Object.entries(instances)) {
    let found: { clip: Record<string, unknown>; trackOrder: number } | undefined;
    composition?.tracks?.forEach((track, trackOrder) => {
      if (track.kind !== 'video' || track.family === 'audio' || track.family === 'caption') return;
      const clip = track.clips?.find((candidate) => candidate.id === instance.clipId);
      if (clip) found = { clip, trackOrder };
    });
    if (!found) continue;
    const startUs = Number(found.clip.startUs ?? 0);
    const durationUs = Number(found.clip.durationUs ?? 0);
    sources.push({ instanceId, instance, startUs, durationUs, trackOrder: found.trackOrder });
  }
  return sources
    .sort((a, b) => a.trackOrder - b.trackOrder || a.startUs - b.startUs)
    .map(({ trackOrder: _trackOrder, ...source }) => source);
}

function withoutTitleClips(
  project: CliProjectDocument,
  sources: readonly TitleFrameSource[],
): CliProjectDocument {
  const clipIds = new Set(sources.map((source) => source.instance.clipId));
  if (clipIds.size === 0) return project;
  const objectIds = new Set(sources.map((source) => source.instance.objectId));
  const copy = structuredClone(project) as unknown as Record<string, unknown>;
  const compositions = copy.compositions as Record<
    string,
    { tracks?: Array<{ clips?: Array<{ id?: string }> }> }
  >;
  const root = compositions[String(copy.rootCompositionId)];
  for (const track of root?.tracks ?? [])
    track.clips = (track.clips ?? []).filter((clip) => !clipIds.has(String(clip.id)));
  const visualObjects = copy.visualObjects as Record<string, unknown> | undefined;
  for (const objectId of objectIds) delete visualObjects?.[objectId];
  const pluginData = copy.pluginData as Record<string, unknown> | undefined;
  if (pluginData) {
    delete pluginData[CONTENT_TEMPLATES_PLUGIN_KEY];
    const rawBindings = pluginData['joy.clipObjects'];
    if (isRecord(rawBindings)) {
      const bindings = { ...rawBindings };
      for (const clipId of clipIds) delete bindings[clipId];
      pluginData['joy.clipObjects'] = bindings;
    }
  }
  return copy as unknown as CliProjectDocument;
}

function rootCompositionOf(project: CliProjectDocument): Record<string, unknown> {
  return project.compositions[project.rootCompositionId] as unknown as Record<string, unknown>;
}

function compositionFrameRate(project: CliProjectDocument): { num: number; den: number } {
  const rate = rootCompositionOf(project)['frameRate'];
  if (
    isRecord(rate) &&
    Number.isSafeInteger(rate['num']) &&
    Number.isSafeInteger(rate['den']) &&
    Number(rate['num']) > 0 &&
    Number(rate['den']) > 0
  ) {
    return { num: Number(rate['num']), den: Number(rate['den']) };
  }
  return { num: 30, den: 1 };
}

function ffmpegVersionLine(): string {
  const result = spawnSync(ffmpegBinary(), ['-version'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  return result.status === 0
    ? (result.stdout.split(/\r?\n/, 1)[0] ?? 'unavailable')
    : 'unavailable';
}

function stableLayoutHash(layout: TitleInstanceV1['layout']): string {
  return sha256Hex(
    JSON.stringify({
      primaryLines: layout.primaryLines,
      secondaryLines: layout.secondaryLines,
      fontSizePx: layout.fontSizePx,
      secondarySizePx: layout.secondarySizePx,
      lineHeightPx: layout.lineHeightPx,
      boxHeightPx: layout.boxHeightPx,
    }),
  );
}

export function previewFrameIndex(
  timeUs: number,
  fps: { readonly num: number; readonly den: number },
): number {
  if (
    !Number.isSafeInteger(timeUs) ||
    timeUs < 0 ||
    !Number.isSafeInteger(fps.num) ||
    !Number.isSafeInteger(fps.den) ||
    fps.num < 1 ||
    fps.den < 1
  )
    throw new RangeError('preview time and frame rate must be non-negative safe integers');
  return Number((BigInt(timeUs) * BigInt(fps.num)) / (1_000_000n * BigInt(fps.den)));
}

export function isPreviewTimeInRange(timeUs: number, durationUs: number): boolean {
  return (
    Number.isSafeInteger(timeUs) &&
    Number.isSafeInteger(durationUs) &&
    timeUs >= 0 &&
    timeUs < durationUs
  );
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export async function runHeadlessRender(
  input: RunHeadlessRenderInput,
): Promise<RenderCommandResult> {
  const { project, preset, outDir, concurrency, json } = input;
  const showProgress = !json && (input.progress ?? Boolean(process.stdout.isTTY));
  const presetSpec = RENDER_PRESETS[preset];
  const startedAt = performance.now();
  const rawId = (project as { id?: unknown } | null | undefined)?.id;
  const knownProjectId = typeof rawId === 'string' ? rawId : '';

  const failure = (
    code: RenderErrorCode,
    message: string,
    totalFrames = 0,
    totalClips = 0,
  ): RenderCommandResult => {
    const exitCode = code === 'cancelled' ? longRunningCancellationExitCode : 1;
    failCommand(json, knownProjectId, code, message, exitCode);
    return {
      exitCode,
      projectId: knownProjectId,
      preset,
      outDir,
      artifactPath: '',
      totalFrames,
      totalClips,
      durationMs: performance.now() - startedAt,
      mediaProduced: false,
      manifestWritten: false,
      warnings: [],
    };
  };

  const plan = planRender(project, presetSpec);
  if (!plan.ok) return failure('invalid-project', plan.message);

  const titleSources = collectTitleSources(project);
  const composition = rootCompositionOf(project);
  if (titleSources.length > 8)
    return failure('SLICE_LIMIT', 'At most 8 title instances are supported.');
  const titleWidth = Number(composition['width']);
  const titleHeight = Number(composition['height']);
  const titleFps = compositionFrameRate(project);
  const compositionDurationUs = Number(composition['durationUs']);
  if (
    titleSources.length > 0 &&
    (compositionDurationUs > 60_000_000 ||
      titleWidth > 1920 ||
      titleHeight > 1920 ||
      titleFps.num > 60 * titleFps.den)
  )
    return failure(
      'SLICE_LIMIT',
      'Title rendering supports compositions up to 60 seconds, 1920x1920 and 60 fps.',
    );

  const mediaPlan = planMedia(
    withoutTitleClips(project, titleSources),
    { manifestOnly: input.manifestOnly === true, mediaDir: input.mediaDir },
    presetSpec,
  );
  if (mediaPlan.mode === 'error') return failure(mediaPlan.code, mediaPlan.message);
  const realMediaBase = mediaPlan.mode === 'media' ? mediaPlan : null;
  const realMedia: MediaPlanReady | null = realMediaBase
    ? {
        ...realMediaBase,
        durationUs:
          titleSources.length > 0 && Number.isSafeInteger(compositionDurationUs)
            ? Math.max(realMediaBase.durationUs, compositionDurationUs)
            : realMediaBase.durationUs,
      }
    : null;

  const allClips = realMedia
    ? plan.clips.map((clip) => {
        const mediaClip = realMedia.clips.find(
          (candidate) => candidate.clipId === clip.clipId && candidate.trackId === clip.trackId,
        );
        const titleSource = titleSources.find((source) => source.instance.clipId === clip.clipId);
        if (!mediaClip && !titleSource) return clip;
        const startUs = mediaClip?.startUs ?? titleSource!.startUs;
        const durationUs = mediaClip?.durationUs ?? titleSource!.durationUs;
        const firstFrame = frameBoundaryAtUs(startUs, realMedia.fps);
        const endFrame = frameBoundaryAtUs(startUs + durationUs, realMedia.fps);
        return {
          ...clip,
          startUs,
          durationUs,
          firstFrame,
          frames: Math.max(1, endFrame - firstFrame),
        };
      })
    : plan.clips;
  const totalFrames = realMedia
    ? Math.max(1, ...allClips.map((clip) => clip.firstFrame + clip.frames))
    : plan.totalFrames;
  // A real render uses the project's own size and frame rate, so the "preset is fixed at ..."
  // note from planning does not apply to it.
  const warnings = [
    ...(realMedia ? plan.warnings.filter((w) => !w.includes('is fixed at')) : plan.warnings),
    ...(realMedia ? realMedia.warnings : []),
  ];
  const totalClips = allClips.length;

  if (input.frameUs !== undefined) {
    const timeUs = input.frameUs;
    const durationUs =
      Number.isSafeInteger(compositionDurationUs) && compositionDurationUs > 0
        ? compositionDurationUs
        : (realMedia?.durationUs ?? plan.composition.durationUs ?? 0);
    if (!isPreviewTimeInRange(timeUs, durationUs))
      return failure(
        'RANGE_ERROR',
        `Preview time ${String(timeUs)}µs is outside [0, ${durationUs})µs.`,
        totalFrames,
        totalClips,
      );
    if (!realMedia)
      return failure(
        'nothing-to-render',
        'Preview requires at least one resolvable media clip.',
        totalFrames,
        totalClips,
      );
    const frameIndex = previewFrameIndex(timeUs, titleFps);
    const previewMedia = { ...realMedia, durationUs };
    const artifactPath = join(outDir, `preview-${frameIndex}.png`);
    const outputProblem = prepareOutputDir(outDir, [artifactPath]);
    if (outputProblem) return failure('output', outputProblem, totalFrames, totalClips);
    let captured;
    try {
      captured = await renderTitleFrames(titleSources, {
        width: titleWidth,
        height: titleHeight,
        fps: titleFps,
      });
    } catch (error) {
      return failure('unsupported-feature', errorMessage(error), totalFrames, totalClips);
    }
    try {
      const handle = startEncode(
        buildFfmpegArgs(previewMedia, preset, artifactPath, captured.layers, { timeUs }),
        durationUs,
        () => {},
      );
      const outcome = await handle.done;
      if (!outcome.ok) return failure(outcome.code, outcome.message, totalFrames, totalClips);
      if (!existsSync(artifactPath))
        return failure(
          'encode-failed',
          'FFmpeg did not produce the requested preview PNG.',
          totalFrames,
          totalClips,
        );
      const previewEvent: RenderPreviewCompleteEvent = {
        schemaVersion: 1,
        type: 'preview-complete',
        projectId: plan.projectId,
        frameIndex,
        timeUs,
        width: titleWidth,
        height: titleHeight,
        artifactPath,
        mediaProduced: true,
      };
      emitJson(previewEvent, json);
      return {
        exitCode: 0,
        projectId: plan.projectId,
        preset,
        outDir,
        artifactPath,
        totalFrames: 1,
        totalClips,
        durationMs: performance.now() - startedAt,
        mediaProduced: true,
        manifestWritten: false,
        warnings,
      };
    } finally {
      captured.cleanup();
    }
  }
  const fileStem = safeFileStem(plan.projectId);
  const mediaName = `${fileStem}.${presetSpec.extension}`;
  const manifestName = `${fileStem}.${presetSpec.extension}.manifest.json`;
  if (fileStem !== plan.projectId) {
    warnings.push(`Project id "${plan.projectId}" is not a safe file name; using "${fileStem}".`);
  }

  if (totalClips > 0) {
    // Fail before doing any work (and before announcing `start`) if the
    // destination can never be written.
    const outputTargets = realMedia
      ? [join(outDir, mediaName), join(outDir, manifestName)]
      : [join(outDir, manifestName)];
    const outputProblem = prepareOutputDir(outDir, outputTargets);
    if (outputProblem) return failure('output', outputProblem, totalFrames, totalClips);
  }

  let releaseOutputLock: (() => void) | null = null;
  let recordOutputPartialPath: ((partialPath: string | null) => void) | null = null;
  let recordOutputTransaction: ((transaction: OutputTransactionRecord | null) => void) | null =
    null;
  let activeRenderPartialPath: string | null = null;
  if (realMedia) {
    const lockPath = join(outDir, `.${mediaName}.render.lock`);
    const lock = acquireOutputLock(lockPath);
    if (!lock.ok) return failure('output', lock.message, totalFrames, totalClips);
    releaseOutputLock = lock.release;
    recordOutputPartialPath = lock.recordPartialPath;
    recordOutputTransaction = lock.recordTransaction;
  }

  if (!json) {
    printBanner();
    logInfo(`Headless render plan: ${c(plan.title, 'bold')} (${plan.projectId})`);
    logStep('Preset', `${presetSpec.id} (${presetSpec.container}/${presetSpec.videoCodec})`);
    logStep('Manifest', join(outDir, manifestName));
    logStep(
      'Media file',
      realMedia
        ? join(outDir, mediaName)
        : 'none - manifest only, this command does not encode video',
    );
    logStep('Concurrency', String(concurrency));
    logStep('Tracks', String(plan.trackCount));
    logStep('Clips', String(totalClips));
    logStep('Total Frames', String(totalFrames));
    for (const warning of warnings) logWarn(warning);
    console.log();
  }

  emitJson(
    {
      type: 'start',
      projectId: plan.projectId,
      title: plan.title,
      preset,
      outDir,
      totalFrames,
      totalClips,
      concurrency,
      ts: new Date().toISOString(),
    },
    json,
  );

  // Nothing to encode is a failure for a real render; only an explicit plan-only run may stop here.
  if (totalClips === 0 && !input.manifestOnly) {
    return failure('nothing-to-render', NOTHING_RENDERED_MESSAGE);
  }

  if (totalClips === 0) {
    const emptyWarnings = [...warnings, NOTHING_RENDERED_MESSAGE];
    if (!json) logWarn(NOTHING_RENDERED_MESSAGE);
    emitJson(
      {
        type: 'complete',
        projectId: plan.projectId,
        preset,
        outDir,
        artifactPath: '',
        totalFrames,
        durationMs: 0,
        ts: new Date().toISOString(),
        mediaProduced: false,
        manifestWritten: false,
        message: NOTHING_RENDERED_MESSAGE,
        warnings: emptyWarnings,
      },
      json,
    );
    return {
      exitCode: 0,
      projectId: plan.projectId,
      preset,
      outDir,
      artifactPath: '',
      totalFrames: 0,
      totalClips: 0,
      durationMs: 0,
      mediaProduced: false,
      manifestWritten: false,
      warnings: emptyWarnings,
    };
  }

  // Track-level events, in timeline order, one per track that has clips.
  const trackBuckets: Array<{
    trackId: string;
    trackName: string;
    clipCount: number;
  }> = [];
  for (const clip of allClips) {
    const last = trackBuckets[trackBuckets.length - 1];
    if (last && last.trackId === clip.trackId) {
      last.clipCount += 1;
    } else {
      trackBuckets.push({ trackId: clip.trackId, trackName: clip.trackName, clipCount: 1 });
    }
  }
  for (const trk of trackBuckets) {
    emitJson(
      {
        type: 'track',
        projectId: plan.projectId,
        trackId: trk.trackId,
        trackName: trk.trackName,
        clipCount: trk.clipCount,
      },
      json,
    );
  }

  // Process clips with a concurrency-bounded async pool. `renderedFrames` is
  // only a progress counter; each clip's `frameRange` was fixed at planning
  // time (see PlannedClip.firstFrame), so the manifest does not depend on the
  // order workers happen to finish in.
  let renderedFrames = 0;
  let lastDrawnPercent = -1;
  let framesSinceYield = 0;
  let nextClip = 0;
  const workerCount = realMedia ? 0 : Math.min(concurrency, totalClips);
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < workerCount; w += 1) {
    workers.push(
      (async () => {
        for (;;) {
          if (currentLongRunning < 0) return;
          const next = allClips[nextClip];
          nextClip += 1;
          if (!next) break;
          for (let f = 0; f < next.frames; f += 1) {
            if (currentLongRunning < 0) return;
            // Deterministic per-frame work. A real engine would push pixels
            // through an encoder here; this is a placeholder busy-step.
            Math.sin(f * 0.001 + next.frames * 0.0001);
            renderedFrames += 1;
            framesSinceYield += 1;
            if (showProgress) {
              const percent = Math.floor((renderedFrames * 100) / totalFrames);
              if (percent !== lastDrawnPercent) {
                lastDrawnPercent = percent;
                drawProgress(renderedFrames, totalFrames, 32);
              }
            }
            if (framesSinceYield >= FRAMES_PER_SLICE) {
              framesSinceYield = 0;
              await yieldToEventLoop();
              if (currentLongRunning < 0) return;
            }
          }
          if (currentLongRunning < 0) return;
          emitJson(
            {
              type: 'clip',
              projectId: plan.projectId,
              trackId: next.trackId,
              clipId: next.clipId,
              progress: 1,
              framesRendered: renderedFrames,
              totalFrames,
            },
            json,
          );
        }
      })(),
    );
  }

  const mediaPath = realMedia ? join(outDir, mediaName) : '';
  let stagedMediaPath: string | null = null;
  try {
    await Promise.all(workers);
    if (currentLongRunning < 0) {
      return failure(
        'cancelled',
        'Render cancelled; no media or manifest was written.',
        totalFrames,
        totalClips,
      );
    }
    if (realMedia) {
      const partialPath = join(
        outDir,
        `.${mediaName}.${process.pid}.${randomBytes(4).toString('hex')}.partial`,
      );
      try {
        if (!recordOutputPartialPath) throw new Error('Render output lock is unavailable.');
        recordOutputPartialPath(partialPath);
        activeRenderPartialPath = partialPath;
      } catch (err) {
        return failure(
          'output',
          `Cannot record staged media path ${partialPath}: ${errorMessage(err)}`,
          totalFrames,
          totalClips,
        );
      }
      let lastPercent = -1;
      let renderedTitles;
      try {
        renderedTitles = await renderTitleFrames(titleSources, {
          width: titleWidth,
          height: titleHeight,
          fps: titleFps,
        });
      } catch (error) {
        rmSync(partialPath, { force: true });
        return failure('unsupported-feature', errorMessage(error), totalFrames, totalClips);
      }
      let ffmpegArgs: string[];
      try {
        ffmpegArgs = buildFfmpegArgs(realMedia, preset, partialPath, renderedTitles.layers);
      } catch (error) {
        renderedTitles.cleanup();
        rmSync(partialPath, { force: true });
        return failure('encode-failed', errorMessage(error), totalFrames, totalClips);
      }
      const handle = startEncode(ffmpegArgs, realMedia.durationUs, (fraction) => {
        const percent = Math.floor(fraction * 100);
        if (percent === lastPercent) return;
        lastPercent = percent;
        if (showProgress) drawProgress(Math.round(fraction * totalFrames), totalFrames, 32);
        emitJson(
          { type: 'progress', projectId: plan.projectId, percent, ts: new Date().toISOString() },
          json,
        );
      });
      const discardPartial = (): void => {
        handle.cancel();
        try {
          rmSync(partialPath, { force: true });
        } catch {
          // best effort: the partial file is hidden and ignored by every reader
        }
      };
      process.prependListener('SIGINT', discardPartial);
      process.prependListener('SIGTERM', discardPartial);
      let outcome: Awaited<typeof handle.done>;
      try {
        outcome = await handle.done;
      } finally {
        process.off('SIGINT', discardPartial);
        process.off('SIGTERM', discardPartial);
        renderedTitles.cleanup();
      }
      if (currentLongRunning < 0) {
        discardPartial();
        return failure(
          'cancelled',
          'Render cancelled; no media or manifest was written.',
          totalFrames,
          totalClips,
        );
      }
      if (!outcome.ok) {
        discardPartial();
        if (showProgress) process.stdout.write('\n');
        return failure(
          outcome.code === 'cancelled' ? 'cancelled' : outcome.code,
          outcome.message,
          totalFrames,
          totalClips,
        );
      }
      const encodedInfo = probeMedia(partialPath);
      const [fpsNumerator, fpsDenominator] = realMedia.fps.split('/').map(Number);
      const frameDurationUs =
        fpsNumerator && fpsDenominator
          ? (1_000_000 * fpsDenominator) / fpsNumerator
          : Number.POSITIVE_INFINITY;
      if (
        !encodedInfo?.hasVideo ||
        !encodedInfo.hasAudio ||
        encodedInfo.width !== realMedia.width ||
        encodedInfo.height !== realMedia.height ||
        encodedInfo.durationUs <= 0 ||
        Math.abs(encodedInfo.durationUs - realMedia.durationUs) > frameDurationUs
      ) {
        discardPartial();
        return failure(
          'encode-failed',
          `FFmpeg exited successfully but did not produce playable ${presetSpec.container} media ` +
            `matching the planned ${realMedia.width}x${realMedia.height} ${realMedia.fps} ${realMedia.durationUs}µs timeline.`,
          totalFrames,
          totalClips,
        );
      }
      stagedMediaPath = partialPath;
    }
  } finally {
    if (realMedia && stagedMediaPath === null) {
      if (activeRenderPartialPath && !existsSync(activeRenderPartialPath)) {
        try {
          recordOutputPartialPath?.(null);
          activeRenderPartialPath = null;
        } catch {
          // Keep the stale path in the lock so the next process can clean it safely.
        }
      }
      releaseOutputLock?.();
    }
  }

  const durationMs = performance.now() - startedAt;
  const manifestPath = join(outDir, manifestName);
  const artifactPath = realMedia ? mediaPath : manifestPath;
  const renderedCaptionMode = realMedia ? captionRenderMode(realMedia) : 'none';
  const doneMessage = realMedia
    ? `Rendered ${basename(mediaPath)} with ffmpeg. Captions: ${renderedCaptionMode}.`
    : MANIFEST_ONLY_MESSAGE;

  const rendererFacts = await titleRendererFacts();
  const rendererFingerprint = sha256Hex(
    JSON.stringify({
      ffmpegVersion: ffmpegVersionLine(),
      chromiumVersion: rendererFacts.chromiumVersion,
      templateSha256: titleSources.map((source) => source.instance.templateSha256),
      fontManifestHashes: rendererFacts.fontManifestHashes,
    }),
  );

  const manifest = {
    schemaVersion: 2,
    format: 'joy-media-render-manifest',
    mediaProduced: realMedia !== null,
    mediaFile: realMedia ? mediaName : null,
    note: realMedia
      ? 'Video rendered with ffmpeg; this manifest describes the timeline plan it came from.'
      : MANIFEST_ONLY_MESSAGE,
    ...(realMedia
      ? {
          media: {
            width: realMedia.width,
            height: realMedia.height,
            fps: realMedia.fps,
            durationUs: realMedia.durationUs,
            bytes: fileSize(stagedMediaPath ?? mediaPath),
          },
        }
      : {}),
    projectId: plan.projectId,
    projectTitle: plan.title,
    preset,
    captions: { mode: renderedCaptionMode },
    spec: realMedia
      ? {
          ...presetSpec,
          width: realMedia.width,
          height: realMedia.height,
          fps: Number(realMedia.fps.split('/')[0]) / Number(realMedia.fps.split('/')[1] ?? 1),
        }
      : presetSpec,
    composition: plan.composition,
    totalFrames,
    totalClips,
    durationMs,
    renderedAt: new Date().toISOString(),
    warnings,
    renderer: {
      id: 'ffmpeg+chromium-scene-surface',
      version: 1,
      fingerprint: rendererFingerprint,
    },
    design: {
      units: { time: 'us', position: 'px' },
      instances: titleSources.map((source) => ({
        instanceId: source.instanceId,
        objectId: source.instance.objectId,
        clipId: source.instance.clipId,
        templateId: source.instance.templateId,
        templateVersion: source.instance.templateVersion,
        startUs: source.startUs,
        durationUs: source.durationUs,
        fontSha256: source.instance.font.sha256,
        layoutSha256: stableLayoutHash(source.instance.layout),
      })),
    },
    // Real-media frame ranges use output timeline positions. Manifest-only
    // planning retains its legacy sequential ranges because it has no encoder.
    clips: allClips.map((clip) => ({
      clipId: clip.clipId,
      trackId: clip.trackId,
      frames: clip.frames,
      frameRange: { first: clip.firstFrame, last: clip.firstFrame + clip.frames - 1 },
      startUs: clip.startUs,
      durationUs: clip.durationUs,
    })),
  };

  try {
    const manifestData = `${JSON.stringify(manifest, null, 2)}\n`;
    if (realMedia && stagedMediaPath) {
      const stagedManifestPath = writeFileTemp(manifestPath, manifestData);
      try {
        if (!recordOutputTransaction) throw new Error('Render output lock is unavailable.');
        installOutputPair(
          stagedMediaPath,
          mediaPath,
          stagedManifestPath,
          manifestPath,
          recordOutputTransaction,
        );
      } catch (err) {
        rmSync(stagedManifestPath, { force: true });
        throw err;
      }
      stagedMediaPath = null;
      activeRenderPartialPath = null;
      releaseOutputLock?.();
      releaseOutputLock = null;
      // Timeline order, so the reported progress never moves backward.
      const inTimelineOrder = [...allClips].sort(
        (a, b) => a.firstFrame + a.frames - (b.firstFrame + b.frames),
      );
      for (const clip of inTimelineOrder) {
        emitJson(
          {
            type: 'clip',
            projectId: plan.projectId,
            trackId: clip.trackId,
            clipId: clip.clipId,
            progress: 1,
            // Progress through the whole timeline: the frame this clip's output reaches.
            framesRendered: clip.firstFrame + clip.frames,
            totalFrames,
          },
          json,
        );
      }
    } else {
      writeFileAtomic(manifestPath, manifestData);
    }
  } catch (err) {
    const cleanupFailures: string[] = [];
    if (stagedMediaPath) {
      try {
        rmSync(stagedMediaPath, { force: true });
      } catch (cleanupErr) {
        // Keep the lock's staged-path journal intact so the next render can recover it.
        cleanupFailures.push(errorMessage(cleanupErr));
      }
    }
    if (activeRenderPartialPath && !existsSync(activeRenderPartialPath)) {
      try {
        recordOutputPartialPath?.(null);
        activeRenderPartialPath = null;
      } catch {
        // Keep the stale path in the lock so the next process can clean it safely.
      }
    }
    try {
      releaseOutputLock?.();
    } catch (cleanupErr) {
      // A read-only output directory can prevent lock removal. The stale journal
      // remains recoverable once the user restores write permission.
      cleanupFailures.push(errorMessage(cleanupErr));
    }
    releaseOutputLock = null;
    if (showProgress) process.stdout.write('\n');
    const cleanupNote =
      cleanupFailures.length > 0
        ? ` Output cleanup is deferred until the directory is writable again: ${cleanupFailures.join('; ')}`
        : '';
    return failure(
      'output',
      `Failed to write render manifest ${manifestPath}: ${errorMessage(err)}${cleanupNote}`,
      totalFrames,
      totalClips,
    );
  }

  if (!json) {
    if (showProgress) {
      drawProgress(totalFrames, totalFrames, 32);
      process.stdout.write('\n\n');
    }
    if (realMedia) {
      const megabytes = (fileSize(mediaPath) / (1024 * 1024)).toFixed(1);
      logSuccess(
        `Rendered ${basename(mediaPath)} (${(realMedia.durationUs / 1e6).toFixed(2)}s, ` +
          `${realMedia.width}x${realMedia.height}, ${megabytes} MB) in ${durationMs}ms.`,
      );
      logStep('Video', mediaPath);
      logStep('Manifest', manifestPath);
    } else {
      logSuccess(
        `Wrote render manifest for ${totalClips} clip(s) / ${totalFrames} frame(s) in ${durationMs}ms.`,
      );
      logWarn(MANIFEST_ONLY_MESSAGE);
      logStep('Manifest', artifactPath);
    }
  }

  emitJson(
    {
      type: 'complete',
      projectId: plan.projectId,
      preset,
      outDir,
      artifactPath,
      totalFrames,
      durationMs,
      ts: new Date().toISOString(),
      mediaProduced: realMedia !== null,
      ...(realMedia ? { mediaPath, manifestPath } : {}),
      manifestWritten: true,
      message: doneMessage,
      warnings,
    },
    json,
  );

  return {
    exitCode: 0,
    projectId: plan.projectId,
    preset,
    outDir,
    artifactPath,
    totalFrames,
    totalClips,
    durationMs,
    mediaProduced: realMedia !== null,
    ...(realMedia ? { mediaPath } : {}),
    manifestWritten: true,
    warnings,
  };
}

export function isRenderPresetId(value: string): value is RenderPresetSpec['id'] {
  return value === 'mp4' || value === 'webm' || value === 'prores';
}

export function describeRenderPreset(id: string): RenderPresetSpec | null {
  return isRenderPresetId(id) ? RENDER_PRESETS[id] : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}

/**
 * Report a failure the same way everywhere: one line on stderr for humans and,
 * under `--json`, a terminal `error` event on stdout for machines.
 */
function failCommand(
  json: boolean,
  projectId: string,
  code: RenderErrorCode,
  message: string,
  exitCode: number,
): number {
  logError(message);
  emitJson({ type: 'error', projectId, message, ts: new Date().toISOString(), code }, json);
  return exitCode;
}

function emitJson(event: RenderEvent, json: boolean): void {
  if (!json) return;
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Create `dir` if needed and check it is a writable directory. Returns a problem or null. */
function prepareOutputDir(dir: string, targets: readonly string[] = []): string | null {
  let existing: ReturnType<typeof statSync> | undefined;
  try {
    existing = statSync(dir);
  } catch {
    existing = undefined;
  }
  if (existing && !existing.isDirectory()) {
    return `Output path "${dir}" exists and is not a directory. Pass --out <directory>.`;
  }
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch (err) {
    return `Cannot use output directory "${dir}": ${errorMessage(err)}`;
  }
  for (const target of targets) {
    try {
      if (statSync(target).isDirectory()) {
        return `Output file path "${target}" exists as a directory.`;
      }
    } catch {
      // A missing output file is expected before the render starts.
    }
  }
  return null;
}

interface OutputTransactionRecord {
  readonly phase: 'committing' | 'committed';
  readonly mediaPath: string;
  readonly stagedMediaPath: string;
  readonly mediaBackup: string;
  readonly hadMedia: boolean;
  readonly manifestPath: string;
  readonly stagedManifestPath: string;
  readonly manifestBackup: string;
  readonly hadManifest: boolean;
}

interface OutputLockRecord {
  pid: number;
  startedAt: string;
  activePartialPath: string | null;
  transaction: OutputTransactionRecord | null;
}

/** Claim one real output pair so concurrent renders cannot cross-publish it. */
function acquireOutputLock(path: string):
  | {
      readonly ok: true;
      readonly release: () => void;
      readonly recordPartialPath: (partialPath: string | null) => void;
      readonly recordTransaction: (transaction: OutputTransactionRecord | null) => void;
    }
  | { readonly ok: false; readonly message: string } {
  const create = (): number | null => {
    try {
      return openSync(path, 'wx');
    } catch {
      return null;
    }
  };
  let descriptor = create();
  let recoveryFailure = '';
  if (descriptor === null && existsSync(path)) {
    let ownerPid = 0;
    let ownerStartedAt = '';
    let transaction: OutputTransactionRecord | null = null;
    let activePartialPath: string | null = null;
    try {
      const owner = JSON.parse(readFileSync(path, 'utf8')) as {
        pid?: unknown;
        startedAt?: unknown;
        activePartialPath?: unknown;
        transaction?: unknown;
      };
      if (typeof owner.pid === 'number') ownerPid = owner.pid;
      if (typeof owner.startedAt === 'string') ownerStartedAt = owner.startedAt;
      if (typeof owner.activePartialPath === 'string') activePartialPath = owner.activePartialPath;
      else if (owner.activePartialPath !== null && owner.activePartialPath !== undefined) {
        recoveryFailure = 'the active partial path is malformed';
      }
      if (isOutputTransactionRecord(owner.transaction)) transaction = owner.transaction;
      else if (owner.transaction !== null && owner.transaction !== undefined) {
        recoveryFailure = 'the output transaction journal is malformed';
      }
    } catch {
      // A malformed or partially written lock remains busy; never guess that it is stale.
    }
    if (ownerPid > 0 && !isProcessAlive(ownerPid)) {
      try {
        if (recoveryFailure) throw new Error(recoveryFailure);
        recoverOutputLockState(path, transaction, activePartialPath);
        rmSync(path, { force: true });
        descriptor = create();
      } catch (err) {
        recoveryFailure = errorMessage(err);
        descriptor = null;
      }
    }
    if (descriptor === null) {
      return {
        ok: false,
        message:
          ownerPid > 0 && !isProcessAlive(ownerPid)
            ? `A stale render lock could not be recovered at ${path}${recoveryFailure ? `: ${recoveryFailure}` : ''}.`
            : `Another render is writing this output (lock: ${path}${ownerStartedAt ? `, started ${ownerStartedAt}` : ''}).`,
      };
    }
  }
  if (descriptor === null) {
    return { ok: false, message: `Cannot claim render output lock ${path}.` };
  }
  const record: OutputLockRecord = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    activePartialPath: null,
    transaction: null,
  };
  try {
    writeFileSync(descriptor, JSON.stringify(record));
  } catch (err) {
    closeSync(descriptor);
    rmSync(path, { force: true });
    return { ok: false, message: `Cannot write render output lock ${path}: ${errorMessage(err)}` };
  }
  closeSync(descriptor);
  const recordPartialPath = (activePartialPath: string | null): void => {
    const next = { ...record, activePartialPath };
    writeFileAtomic(path, JSON.stringify(next));
    record.activePartialPath = activePartialPath;
  };
  const recordTransaction = (transaction: OutputTransactionRecord | null): void => {
    const next = { ...record, activePartialPath: null, transaction };
    writeFileAtomic(path, JSON.stringify(next));
    record.activePartialPath = null;
    record.transaction = transaction;
  };
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.off('exit', release);
    try {
      const current = JSON.parse(readFileSync(path, 'utf8')) as {
        pid?: unknown;
        activePartialPath?: unknown;
        transaction?: unknown;
      };
      if (
        current.pid === process.pid &&
        ((current.transaction !== null && current.transaction !== undefined) ||
          (typeof current.activePartialPath === 'string' && current.activePartialPath.length > 0))
      ) {
        return;
      }
    } catch {
      // Leave a malformed lock in place; a later command will refuse unsafe recovery.
      return;
    }
    rmSync(path, { force: true });
  };
  process.once('exit', release);
  return { ok: true, release, recordPartialPath, recordTransaction };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function isOutputTransactionRecord(value: unknown): value is OutputTransactionRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record['phase'] === 'committing' || record['phase'] === 'committed') &&
    typeof record['mediaPath'] === 'string' &&
    typeof record['stagedMediaPath'] === 'string' &&
    typeof record['mediaBackup'] === 'string' &&
    typeof record['hadMedia'] === 'boolean' &&
    typeof record['manifestPath'] === 'string' &&
    typeof record['stagedManifestPath'] === 'string' &&
    typeof record['manifestBackup'] === 'string' &&
    typeof record['hadManifest'] === 'boolean'
  );
}

/** Recover a pair transaction left between file renames after its owner exited. */
function recoverOutputTransaction(
  lockPath: string,
  transaction: OutputTransactionRecord | null,
): void {
  if (!transaction) return;
  const parent = resolve(dirname(lockPath));
  const paths = [
    transaction.mediaPath,
    transaction.stagedMediaPath,
    transaction.mediaBackup,
    transaction.manifestPath,
    transaction.stagedManifestPath,
    transaction.manifestBackup,
  ];
  if (paths.some((path) => resolve(dirname(path)) !== parent)) {
    throw new Error('the output transaction journal contains a path outside its output directory');
  }
  const mediaName = basename(transaction.mediaPath);
  const manifestName = `${mediaName}.manifest.json`;
  const generatedPath = (path: string, prefix: string, suffix: string): boolean => {
    const name = basename(path);
    return name.startsWith(prefix) && name.endsWith(suffix);
  };
  if (
    basename(lockPath) !== `.${mediaName}.render.lock` ||
    basename(transaction.manifestPath) !== manifestName ||
    !generatedPath(transaction.stagedMediaPath, `.${mediaName}.`, '.partial') ||
    !generatedPath(transaction.mediaBackup, `.${mediaName}.`, '.backup') ||
    !generatedPath(transaction.stagedManifestPath, `.${manifestName}.`, '.tmp') ||
    !generatedPath(transaction.manifestBackup, `.${manifestName}.`, '.backup')
  ) {
    throw new Error('the output transaction journal contains unexpected output paths');
  }
  if (transaction.phase === 'committed') {
    rmSync(transaction.mediaBackup, { force: true });
    rmSync(transaction.manifestBackup, { force: true });
  } else {
    restoreOutputFile(
      transaction.mediaPath,
      transaction.mediaBackup,
      transaction.stagedMediaPath,
      transaction.hadMedia,
    );
    restoreOutputFile(
      transaction.manifestPath,
      transaction.manifestBackup,
      transaction.stagedManifestPath,
      transaction.hadManifest,
    );
  }
  rmSync(transaction.stagedMediaPath, { force: true });
  rmSync(transaction.stagedManifestPath, { force: true });
}

function recoverOutputLockState(
  lockPath: string,
  transaction: OutputTransactionRecord | null,
  activePartialPath: string | null,
): void {
  if (activePartialPath) {
    const mediaName = basename(lockPath)
      .replace(/^\./u, '')
      .replace(/\.render\.lock$/u, '');
    const parent = resolve(dirname(lockPath));
    if (
      resolve(dirname(activePartialPath)) !== parent ||
      !basename(activePartialPath).startsWith(`.${mediaName}.`) ||
      !basename(activePartialPath).endsWith('.partial')
    ) {
      throw new Error('the output lock contains an unexpected partial-media path');
    }
    rmSync(activePartialPath, { force: true });
  }
  recoverOutputTransaction(lockPath, transaction);
}

function restoreOutputFile(
  target: string,
  backup: string,
  staged: string,
  existedBefore: boolean,
): void {
  if (existsSync(backup)) {
    rmSync(target, { force: true });
    renameSync(backup, target);
  } else if (!existedBefore && !existsSync(staged)) {
    // The staged file was already renamed to the public path before interruption.
    rmSync(target, { force: true });
  }
}

/** Write via a sibling temp file + rename so readers never see a half-written manifest. */
function writeFileAtomic(path: string, data: string): void {
  const tmp = writeFileTemp(path, data);
  try {
    replaceFileWithRetry(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Retry transient Windows sharing violations while another process reads the lock journal. */
function replaceFileWithRetry(source: string, target: string): void {
  const retryableWindowsErrors = new Set(['EACCES', 'EBUSY', 'EPERM']);
  const waitCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const attempts = process.platform === 'win32' ? 25 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== 'win32' ||
        !retryableWindowsErrors.has(code ?? '') ||
        attempt === attempts - 1
      ) {
        throw error;
      }
      Atomics.wait(waitCell, 0, 0, 10);
    }
  }
}

/** Create a sibling temp file and leave it ready for a later atomic rename. */
function writeFileTemp(path: string, data: string): string {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(tmp, data, 'utf8');
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return tmp;
}

/** Replace the media and its manifest as a recoverable pair. */
function installOutputPair(
  stagedMediaPath: string,
  mediaPath: string,
  stagedManifestPath: string,
  manifestPath: string,
  recordTransaction: (transaction: OutputTransactionRecord | null) => void,
): void {
  const suffix = `${process.pid}.${randomBytes(6).toString('hex')}.backup`;
  const mediaBackup = join(dirname(mediaPath), `.${basename(mediaPath)}.${suffix}`);
  const manifestBackup = join(dirname(manifestPath), `.${basename(manifestPath)}.${suffix}`);
  let transaction: OutputTransactionRecord | null = null;
  try {
    for (const target of [mediaPath, manifestPath]) {
      if (existsSync(target) && statSync(target).isDirectory()) {
        throw new Error(`Output file path "${target}" exists as a directory.`);
      }
    }
    transaction = {
      phase: 'committing',
      mediaPath,
      stagedMediaPath,
      mediaBackup,
      hadMedia: existsSync(mediaPath),
      manifestPath,
      stagedManifestPath,
      manifestBackup,
      hadManifest: existsSync(manifestPath),
    };
    recordTransaction(transaction);
    if (transaction.hadMedia) {
      renameSync(mediaPath, mediaBackup);
    }
    if (transaction.hadManifest) {
      renameSync(manifestPath, manifestBackup);
    }
    renameSync(stagedMediaPath, mediaPath);
    renameSync(stagedManifestPath, manifestPath);
    transaction = { ...transaction, phase: 'committed' };
    recordTransaction(transaction);
  } catch (err) {
    let detail = '';
    if (transaction) {
      try {
        recoverOutputTransaction(
          join(dirname(mediaPath), `.${basename(mediaPath)}.render.lock`),
          transaction,
        );
        recordTransaction(null);
      } catch (rollbackError) {
        detail = ` Output recovery failed: ${errorMessage(rollbackError)}.`;
      }
    }
    throw new Error(`${errorMessage(err)}.${detail}`);
  }
  try {
    rmSync(mediaBackup, { force: true });
    rmSync(manifestBackup, { force: true });
    recordTransaction(null);
  } catch {
    // The committed journal stays in the lock; a later render cleans up these backups.
  }
}

function drawProgress(current: number, total: number, width: number): void {
  if (total <= 0) return;
  const ratio = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(width * ratio);
  const bar = `${c('█'.repeat(filled), 'green')}${c('░'.repeat(width - filled), 'dim')}`;
  const pct = (ratio * 100).toFixed(1).padStart(5, ' ');
  process.stdout.write(`\r  ${bar} ${c(pct + '%', 'bold')} ${current}/${total} frames`);
}

export function resolveRenderProjectTarget(
  identifier: string | undefined,
  sqlitePath?: string,
): {
  project: CliProjectDocument;
  revision: number;
  source: 'sqlite' | 'file';
  path: string;
} | null {
  if (!identifier) {
    const available = listProjects(sqlitePath);
    if (available.length > 0) {
      const newest = available[0]!;
      return loadProject(newest.id, sqlitePath);
    }
    return null;
  }
  return loadProject(identifier, sqlitePath);
}
