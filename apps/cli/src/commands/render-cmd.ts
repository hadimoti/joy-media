/* global console, process */
/**
 * Headless batch render command.
 *
 * `joy render --project <id|file.json> --preset <mp4|webm|prores> --out <dir>`
 *
 * By default, renders through FFmpeg and writes a verified media file plus a
 * manifest. `--manifest-only` retains the deterministic benchmark simulation.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliFlags } from '../cli.js';
import { parseIntFlag } from '../utils/flags.js';
import {
  c,
  logError,
  logInfo,
  logStep,
  logSuccess,
  logWarn,
  printBanner,
} from '../utils/logger.js';
import { listProjects, loadProject, type createDefaultProject } from '../utils/project-loader.js';
import { buildFfmpegRenderPlan } from '../render/ffmpeg-plan.js';
import { runFfmpegRender } from '../render/ffmpeg-run.js';

export interface RenderCommandFlags {
  project?: string | undefined;
  preset?: string | undefined;
  out?: string | undefined;
  concurrency?: number | undefined;
  json?: boolean | undefined;
  sqlitePath?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  fps?: number | undefined;
  strict?: boolean | undefined;
  manifestOnly?: boolean | undefined;
}

export function printRenderHelp(): void {
  console.log(`Usage: joy-media render --project <id|file.json> --preset <mp4|webm|prores> --out <directory>
Options: --width <px> --height <px> --fps <rate> --strict --manifest-only --concurrency <1-32> --json`);
}

export interface RenderPresetSpec {
  readonly id: 'mp4' | 'webm' | 'prores';
  readonly container: string;
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly extension: string;
}

export const RENDER_PRESETS: Readonly<Record<RenderPresetSpec['id'], RenderPresetSpec>> = {
  mp4: {
    id: 'mp4',
    container: 'mp4',
    videoCodec: 'h264',
    audioCodec: 'aac',
    extension: 'mp4',
  },
  webm: {
    id: 'webm',
    container: 'webm',
    videoCodec: 'vp9',
    audioCodec: 'opus',
    extension: 'webm',
  },
  prores: {
    id: 'prores',
    container: 'mov',
    videoCodec: 'prores-ks',
    audioCodec: 'pcm-s24le',
    extension: 'mov',
  },
};

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
}

export interface RenderErrorEvent {
  readonly type: 'error';
  readonly projectId: string;
  readonly message: string;
  readonly ts: string;
}

export interface RenderProgressEvent {
  readonly type: 'progress';
  readonly framesRendered: number;
  readonly totalFrames: number;
}

export type RenderEvent =
  | RenderStartEvent
  | RenderClipEvent
  | RenderTrackEvent
  | RenderCompleteEvent
  | RenderErrorEvent
  | RenderProgressEvent;

export interface RenderCommandResult {
  readonly exitCode: number;
  readonly projectId: string;
  readonly preset: RenderPresetSpec['id'];
  readonly outDir: string;
  readonly artifactPath: string;
  readonly totalFrames: number;
  readonly totalClips: number;
  readonly durationMs: number;
}

export async function handleRenderCommand(args: string[], flags: CliFlags): Promise<number> {
  void args;

  const presetRaw = (flags.preset ?? 'mp4').toLowerCase();
  if (!isRenderPresetId(presetRaw)) {
    logError(`Unknown render preset "${presetRaw}". Available: mp4, webm, prores.`);
    return 2;
  }
  const preset = presetRaw as RenderPresetSpec['id'];

  const outDir = flags.out ?? './renders';
  const concurrency =
    parseIntFlag('concurrency', flags.concurrency, {
      min: 1,
      max: 32,
      allowZero: false,
    }) ?? 2;
  const json = Boolean(flags.json);

  if (!flags.project) {
    logError('Please specify target project via --project <id|file.json>');
    return 1;
  }

  let projectInfo;
  try {
    projectInfo = loadProject(flags.project, flags.sqlitePath);
  } catch (err) {
    if (!json) logError(`Cannot load project: ${String(err)}`);
    emitJson(
      {
        type: 'error',
        projectId: flags.project,
        message: String(err),
        ts: new Date().toISOString(),
      },
      json,
    );
    return 1;
  }

  const result = await runHeadlessRender({
    project: projectInfo.project,
    preset,
    outDir,
    concurrency,
    json,
    width: flags.width,
    height: flags.height,
    fps: flags.fps,
    strict: flags.strict,
    manifestOnly: flags.manifestOnly,
  });

  return result.exitCode;
}

export interface RunHeadlessRenderInput {
  readonly project: ReturnType<typeof createDefaultProject>;
  readonly preset: RenderPresetSpec['id'];
  readonly outDir: string;
  readonly concurrency: number;
  readonly json: boolean;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly fps?: number | undefined;
  readonly strict?: boolean | undefined;
  readonly manifestOnly?: boolean | undefined;
}

export async function runHeadlessRender(
  input: RunHeadlessRenderInput,
): Promise<RenderCommandResult> {
  const { project, preset, outDir, concurrency, json } = input;
  const presetSpec = RENDER_PRESETS[preset];
  const startedAt = Date.now();

  if (!input.manifestOnly) return runFfmpegHeadlessRender(input);

  const root = project.compositions[project.rootCompositionId];
  const projectFps = root ? root.frameRate.num / root.frameRate.den : 30;
  const allClips: Array<{
    trackId: string;
    trackName: string;
    clipId: string;
    frames: number;
  }> = [];

  if (root) {
    for (const track of root.tracks ?? []) {
      for (const clip of track.clips ?? []) {
        const durationUs = typeof clip.durationUs === 'number' ? clip.durationUs : 0;
        const frames = Math.max(1, Math.round((durationUs / 1_000_000) * projectFps));
        allClips.push({
          trackId: track.id,
          trackName: track.name ?? track.id,
          clipId: clip.id,
          frames,
        });
      }
    }
  }

  const totalFrames = allClips.reduce((acc, c) => acc + c.frames, 0);
  const totalClips = allClips.length;

  if (!json) {
    printBanner();
    logInfo(`Headless batch render: ${c(project.title, 'bold')} (${project.id})`);
    logStep('Preset', `${presetSpec.id} (${presetSpec.container}/${presetSpec.videoCodec})`);
    logStep('Output', join(outDir, `${project.id}.${presetSpec.extension}`));
    logStep('Concurrency', String(concurrency));
    logStep('Tracks', String(root?.tracks.length ?? 0));
    logStep('Clips', String(totalClips));
    logStep('Total Frames', String(totalFrames));
    console.log();
  }

  if (totalClips === 0) {
    if (!json) {
      logWarn('No clips to render. Project has tracks but no clips on the root composition.');
    }
    emitJson(
      {
        type: 'start',
        projectId: project.id,
        title: project.title,
        preset,
        outDir,
        totalFrames,
        totalClips,
        concurrency,
        ts: new Date().toISOString(),
      },
      json,
    );
    emitJson(
      {
        type: 'complete',
        projectId: project.id,
        preset,
        outDir,
        artifactPath: '',
        totalFrames,
        durationMs: 0,
        ts: new Date().toISOString(),
      },
      json,
    );
    return {
      exitCode: 0,
      projectId: project.id,
      preset,
      outDir,
      artifactPath: '',
      totalFrames: 0,
      totalClips: 0,
      durationMs: 0,
    };
  }

  // Emit start
  emitJson(
    {
      type: 'start',
      projectId: project.id,
      title: project.title,
      preset,
      outDir,
      totalFrames,
      totalClips,
      concurrency,
      ts: new Date().toISOString(),
    },
    json,
  );

  // Group clips by track, preserving order, for track-level events
  const groupedByTrack = new Map<
    string,
    { trackId: string; trackName: string; clipIds: string[]; frames: number[] }
  >();
  for (const clip of allClips) {
    let bucket = groupedByTrack.get(clip.trackId);
    if (!bucket) {
      bucket = { trackId: clip.trackId, trackName: clip.trackName, clipIds: [], frames: [] };
      groupedByTrack.set(clip.trackId, bucket);
    }
    bucket.clipIds.push(clip.clipId);
    bucket.frames.push(clip.frames);
  }

  const tracksOrdered = Array.from(groupedByTrack.values());

  // Emit track events
  for (const trk of tracksOrdered) {
    emitJson(
      {
        type: 'track',
        projectId: project.id,
        trackId: trk.trackId,
        trackName: trk.trackName,
        clipCount: trk.clipIds.length,
      },
      json,
    );
  }

  let renderedFrames = 0;
  const manifestClips: Array<{
    clipId: string;
    trackId: string;
    frames: number;
    frameRange: { first: number; last: number };
  }> = [];

  // Process clips with a simple concurrency-bounded async pool
  const queue = allClips.slice();
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < concurrency; w += 1) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const next = queue.shift();
          if (!next) break;
          const clipStart = renderedFrames;
          for (let f = 0; f < next.frames; f += 1) {
            // Deterministic per-frame work — keeps the bench reproducible.
            // A real engine would push pixels through ffmpeg; this is a
            // timing-accurate simulation of that work for CLI benchmarking.
            Math.sin(f * 0.001 + next.frames * 0.0001);
            renderedFrames += 1;
            if (!json && totalFrames > 0 && renderedFrames % 25 === 0) {
              drawProgress(renderedFrames, totalFrames, 32);
            }
          }
          const clipProgress = 1;
          emitJson(
            {
              type: 'clip',
              projectId: project.id,
              trackId: next.trackId,
              clipId: next.clipId,
              progress: clipProgress,
              framesRendered: renderedFrames,
              totalFrames,
            },
            json,
          );
          manifestClips.push({
            clipId: next.clipId,
            trackId: next.trackId,
            frames: next.frames,
            frameRange: { first: clipStart, last: renderedFrames - 1 },
          });
        }
      })(),
    );
  }

  await Promise.all(workers);

  const finishedAt = Date.now();
  const durationMs = finishedAt - startedAt;

  // Write artifact manifest
  let artifactPath = '';
  try {
    mkdirSync(outDir, { recursive: true });
    artifactPath = join(outDir, `${project.id}.${presetSpec.extension}.manifest.json`);
    const manifest = {
      schemaVersion: 1,
      format: 'joy-media-render-manifest',
      projectId: project.id,
      projectTitle: project.title,
      preset,
      spec: presetSpec,
      totalFrames,
      totalClips,
      durationMs,
      renderedAt: new Date().toISOString(),
      clips: manifestClips,
    };
    writeFileSync(artifactPath, JSON.stringify(manifest, null, 2), 'utf8');
  } catch (err) {
    emitJson(
      {
        type: 'error',
        projectId: project.id,
        message: `Failed to write render manifest: ${String(err)}`,
        ts: new Date().toISOString(),
      },
      json,
    );
    if (!json) logError(`Failed to write render manifest: ${String(err)}`);
    return {
      exitCode: 1,
      projectId: project.id,
      preset,
      outDir,
      artifactPath: '',
      totalFrames,
      totalClips,
      durationMs,
    };
  }

  if (!json) {
    drawProgress(totalFrames, totalFrames, 32);
    process.stdout.write('\n\n');
    logSuccess(`Rendered ${totalClips} clip(s) / ${totalFrames} frame(s) in ${durationMs}ms.`);
    logStep('Artifact', artifactPath);
  }

  emitJson(
    {
      type: 'complete',
      projectId: project.id,
      preset,
      outDir,
      artifactPath,
      totalFrames,
      durationMs,
      ts: new Date().toISOString(),
    },
    json,
  );

  return {
    exitCode: 0,
    projectId: project.id,
    preset,
    outDir,
    artifactPath,
    totalFrames,
    totalClips,
    durationMs,
  };
}

async function runFfmpegHeadlessRender(
  input: RunHeadlessRenderInput,
): Promise<RenderCommandResult> {
  const { project, preset, outDir, json, concurrency } = input;
  const startTime = Date.now();
  const plan = buildFfmpegRenderPlan(project, preset, {
    ...(input.width === undefined ? {} : { width: input.width }),
    ...(input.height === undefined ? {} : { height: input.height }),
    ...(input.fps === undefined ? {} : { fps: input.fps }),
  });
  const root = project.compositions[project.rootCompositionId];
  const fps = Number(plan.fpsExpr.split('/')[0]) / Number(plan.fpsExpr.split('/')[1]);
  const totalFrames = Math.ceil((plan.durationUs / 1_000_000) * fps);
  const totalClips = root?.tracks.reduce((sum, track) => sum + track.clips.length, 0) ?? 0;
  const outDirPath = join(outDir);
  const spec = RENDER_PRESETS[preset];
  const outputPath = join(outDirPath, `${project.id}.${spec.extension}`);
  const manifestPath = `${outputPath}.manifest.json`;
  mkdirSync(outDirPath, { recursive: true });
  if (plan.skipped.length > 0) {
    if (!json) {
      for (const skipped of plan.skipped) logWarn(`Skipped ${skipped.clipId}: ${skipped.reason}`);
    }
    if (input.strict) {
      emitJson(
        {
          type: 'error',
          projectId: project.id,
          message: `Strict render rejected ${plan.skipped.length} unsupported clip(s).`,
          ts: new Date().toISOString(),
        },
        json,
      );
      return {
        exitCode: 3,
        projectId: project.id,
        preset,
        outDir,
        artifactPath: '',
        totalFrames,
        totalClips,
        durationMs: Date.now() - startTime,
      };
    }
  }
  if (!json) {
    printBanner();
    logInfo(`Headless FFmpeg render: ${c(project.title, 'bold')} (${project.id})`);
    logStep('Preset', `${preset} (${spec.container}/${spec.videoCodec})`);
    logStep('Resolution', `${plan.width}x${plan.height} @ ${plan.fpsExpr} fps`);
    logStep('Output', outputPath);
  }
  emitJson(
    {
      type: 'start',
      projectId: project.id,
      title: project.title,
      preset,
      outDir,
      totalFrames,
      totalClips,
      concurrency,
      ts: new Date().toISOString(),
    },
    json,
  );
  let lastFrames = -1;
  try {
    const rendered = await runFfmpegRender({
      plan,
      outputPath,
      preset,
      onProgress: (outTimeUs) => {
        const framesRendered = Math.min(totalFrames, Math.floor((outTimeUs / 1_000_000) * fps));
        if (framesRendered === lastFrames) return;
        lastFrames = framesRendered;
        emitJson({ type: 'progress', framesRendered, totalFrames }, json);
      },
    });
    const durationMs = Date.now() - startTime;
    const manifest = {
      schemaVersion: 1,
      format: 'joy-media-render-manifest',
      projectId: project.id,
      projectTitle: project.title,
      preset,
      skipped: plan.skipped,
      ffmpegVersion: rendered.ffmpegVersion,
      width: plan.width,
      height: plan.height,
      fps: plan.fpsExpr,
      durationUs: plan.durationUs,
      sha256: rendered.sha256,
      output: rendered.probe,
      totalFrames,
      totalClips,
      durationMs,
      renderedAt: new Date().toISOString(),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    if (!json) logSuccess(`Rendered and verified ${outputPath}.`);
    emitJson(
      {
        type: 'complete',
        projectId: project.id,
        preset,
        outDir,
        artifactPath: manifestPath,
        totalFrames,
        durationMs,
        ts: new Date().toISOString(),
      },
      json,
    );
    return {
      exitCode: 0,
      projectId: project.id,
      preset,
      outDir,
      artifactPath: manifestPath,
      totalFrames,
      totalClips,
      durationMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitJson({ type: 'error', projectId: project.id, message, ts: new Date().toISOString() }, json);
    if (!json) logError(message);
    return {
      exitCode: 1,
      projectId: project.id,
      preset,
      outDir,
      artifactPath: '',
      totalFrames,
      totalClips,
      durationMs: Date.now() - startTime,
    };
  }
}

export function isRenderPresetId(value: string): value is RenderPresetSpec['id'] {
  return value === 'mp4' || value === 'webm' || value === 'prores';
}

export function describeRenderPreset(id: string): RenderPresetSpec | null {
  return isRenderPresetId(id) ? RENDER_PRESETS[id] : null;
}

function emitJson(event: RenderEvent, json: boolean): void {
  if (!json) return;
  process.stdout.write(`${JSON.stringify(event)}\n`);
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
