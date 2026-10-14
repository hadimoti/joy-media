/* global console, process, setImmediate */
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
 *
 * Streams progress either as a progress bar (human mode, TTY only) or as
 * newline-delimited JSON events (`--json`). In `--json` mode stdout carries
 * ONLY events, and the last event is always `complete` (exit 0) or `error`
 * (exit non-zero).
 */
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  constants,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { CliFlags } from '../cli.js';
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
import { buildFfmpegArgs, fileSize, planMedia, startEncode } from './render-media.js';
import { listProjects, loadProject, type createDefaultProject } from '../utils/project-loader.js';

export interface RenderCommandFlags {
  project?: string | undefined;
  preset?: string | undefined;
  out?: string | undefined;
  concurrency?: number | undefined;
  json?: boolean | undefined;
  sqlitePath?: string | undefined;
  manifestOnly?: boolean | undefined;
  mediaDir?: string | undefined;
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
  | 'ffmpeg-missing'
  | 'encode-failed';

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

export type RenderEvent =
  | RenderStartEvent
  | RenderClipEvent
  | RenderTrackEvent
  | RenderProgressEvent
  | RenderCompleteEvent
  | RenderErrorEvent;

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
  readonly project: ReturnType<typeof createDefaultProject>;
  readonly preset: RenderPresetSpec['id'];
  readonly outDir: string;
  readonly concurrency: number;
  readonly json: boolean;
  /** Skip ffmpeg and write only the plan manifest. */
  readonly manifestOnly?: boolean | undefined;
  /** Folder to look in for media files an asset names (by id or display name). */
  readonly mediaDir?: string | undefined;
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
    composition,
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

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export async function runHeadlessRender(
  input: RunHeadlessRenderInput,
): Promise<RenderCommandResult> {
  const { project, preset, outDir, concurrency, json } = input;
  const showProgress = !json && (input.progress ?? Boolean(process.stdout.isTTY));
  const presetSpec = RENDER_PRESETS[preset];
  const startedAt = Date.now();
  const rawId = (project as { id?: unknown } | null | undefined)?.id;
  const knownProjectId = typeof rawId === 'string' ? rawId : '';

  const failure = (
    code: RenderErrorCode,
    message: string,
    totalFrames = 0,
    totalClips = 0,
  ): RenderCommandResult => {
    failCommand(json, knownProjectId, code, message, 1);
    return {
      exitCode: 1,
      projectId: knownProjectId,
      preset,
      outDir,
      artifactPath: '',
      totalFrames,
      totalClips,
      durationMs: Date.now() - startedAt,
      mediaProduced: false,
      manifestWritten: false,
      warnings: [],
    };
  };

  const plan = planRender(project, presetSpec);
  if (!plan.ok) return failure('invalid-project', plan.message);

  const mediaPlan = planMedia(
    project,
    { manifestOnly: input.manifestOnly === true, mediaDir: input.mediaDir },
    presetSpec,
  );
  if (mediaPlan.mode === 'error') return failure(mediaPlan.code, mediaPlan.message);
  const realMedia = mediaPlan.mode === 'media' ? mediaPlan : null;

  const { clips: allClips, totalFrames } = plan;
  // A real render uses the project's own size and frame rate, so the "preset is fixed at ..."
  // note from planning does not apply to it.
  const warnings = [
    ...(realMedia ? plan.warnings.filter((w) => !w.includes('is fixed at')) : plan.warnings),
    ...(realMedia ? realMedia.warnings : []),
  ];
  const totalClips = allClips.length;
  const fileStem = safeFileStem(plan.projectId);
  const mediaName = `${fileStem}.${presetSpec.extension}`;
  const manifestName = `${fileStem}.${presetSpec.extension}.manifest.json`;
  if (fileStem !== plan.projectId) {
    warnings.push(`Project id "${plan.projectId}" is not a safe file name; using "${fileStem}".`);
  }

  if (totalClips > 0) {
    // Fail before doing any work (and before announcing `start`) if the
    // destination can never be written.
    const outputProblem = prepareOutputDir(outDir);
    if (outputProblem) return failure('output', outputProblem, totalFrames, totalClips);
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
  const stopWatchingSignals = announceCancellation(json, plan.projectId);
  for (let w = 0; w < workerCount; w += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const next = allClips[nextClip];
          nextClip += 1;
          if (!next) break;
          for (let f = 0; f < next.frames; f += 1) {
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
            }
          }
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

  let mediaPath = '';
  try {
    await Promise.all(workers);
    if (realMedia) {
      const finalPath = join(outDir, mediaName);
      const partialPath = join(outDir, `.${mediaName}.${process.pid}.partial`);
      let lastPercent = -1;
      const handle = startEncode(
        buildFfmpegArgs(realMedia, preset, partialPath),
        realMedia.durationUs,
        (fraction) => {
          const percent = Math.floor(fraction * 100);
          if (percent === lastPercent) return;
          lastPercent = percent;
          if (showProgress) drawProgress(Math.round(fraction * totalFrames), totalFrames, 32);
          emitJson(
            { type: 'progress', projectId: plan.projectId, percent, ts: new Date().toISOString() },
            json,
          );
        },
      );
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
      try {
        renameSync(partialPath, finalPath);
      } catch (err) {
        discardPartial();
        return failure(
          'output',
          `Failed to write ${finalPath}: ${errorMessage(err)}`,
          totalFrames,
          totalClips,
        );
      }
      mediaPath = finalPath;
      let cumulative = 0;
      for (const clip of allClips) {
        cumulative += clip.frames;
        emitJson(
          {
            type: 'clip',
            projectId: plan.projectId,
            trackId: clip.trackId,
            clipId: clip.clipId,
            progress: 1,
            framesRendered: cumulative,
            totalFrames,
          },
          json,
        );
      }
    }
  } finally {
    stopWatchingSignals();
  }

  const durationMs = Date.now() - startedAt;
  const manifestPath = join(outDir, manifestName);
  const artifactPath = realMedia ? mediaPath : manifestPath;
  const doneMessage = realMedia
    ? `Rendered ${basename(mediaPath)} with ffmpeg.`
    : MANIFEST_ONLY_MESSAGE;

  const manifest = {
    schemaVersion: 1,
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
            bytes: fileSize(mediaPath),
          },
        }
      : {}),
    projectId: plan.projectId,
    projectTitle: plan.title,
    preset,
    spec: presetSpec,
    composition: plan.composition,
    totalFrames,
    totalClips,
    durationMs,
    renderedAt: new Date().toISOString(),
    warnings,
    // `frameRange` indexes the render's sequential frame stream (clips in
    // track order, back to back): contiguous and never overlapping. It is
    // not a timeline position; use `startUs`/`durationUs` for that.
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
    writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (err) {
    if (showProgress) process.stdout.write('\n');
    return failure(
      'output',
      `Failed to write render manifest ${manifestPath}: ${errorMessage(err)}`,
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

/**
 * While a render is running, make Ctrl-C / SIGTERM end the `--json` stream with
 * a terminal `error` event. The listener is *prepended* so it writes before the
 * process-wide handler in bin.ts flushes stdout and exits (130).
 */
function announceCancellation(json: boolean, projectId: string): () => void {
  if (!json) return () => undefined;
  let announced = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (announced) return;
    announced = true;
    emitJson(
      {
        type: 'error',
        projectId,
        message: `Render cancelled by ${signal}; no manifest was written.`,
        ts: new Date().toISOString(),
        code: 'cancelled',
      },
      true,
    );
  };
  process.prependListener('SIGINT', onSignal);
  process.prependListener('SIGTERM', onSignal);
  return () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Create `dir` if needed and check it is a writable directory. Returns a problem or null. */
function prepareOutputDir(dir: string): string | null {
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
  return null;
}

/** Write via a sibling temp file + rename so readers never see a half-written manifest. */
function writeFileAtomic(path: string, data: string): void {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(tmp, data, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
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
  project: ReturnType<typeof createDefaultProject>;
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
