/* global Buffer */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { loadAssetSources } from '../utils/asset-sources.js';
import { ffmpegBinary, probeMedia, type MediaInfo } from '../utils/media-probe.js';

/**
 * Real media rendering for `joy-media render`: turn the project's timeline into one video file
 * with ffmpeg. Scope (v1): video/image/audio clips on enabled tracks, placed at their start time,
 * trimmed by `sourceInUs`, later tracks drawn on top of earlier ones, all audio mixed. Anything
 * else (speed changes, reverse, nested compositions, captions, effects) is skipped with a warning
 * instead of being silently ignored.
 */

export type MediaPresetId = 'mp4' | 'webm' | 'prores';

export interface MediaClip {
  readonly clipId: string;
  readonly trackId: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly sourceInUs: number;
  readonly assetId: string;
  readonly sourcePath: string;
  readonly info: MediaInfo;
  /** Contributes pixels (video or still image). */
  readonly visual: boolean;
  /** Contributes sound. */
  readonly audio: boolean;
}

export interface MediaPlanReady {
  readonly mode: 'media';
  readonly clips: readonly MediaClip[];
  readonly width: number;
  readonly height: number;
  /** Frame rate as an ffmpeg rational, e.g. `30/1` or `30000/1001`. */
  readonly fps: string;
  readonly durationUs: number;
  readonly warnings: readonly string[];
}

export type MediaPlan =
  | { readonly mode: 'manifest-only'; readonly reason: string }
  | MediaPlanReady
  | {
      readonly mode: 'error';
      readonly code: 'media-missing' | 'media-unreadable';
      readonly message: string;
    };

interface PresetFallback {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const even = (n: number): number => Math.max(2, n - (n % 2));

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveSource(
  assetId: string,
  asset: unknown,
  sources: Readonly<Record<string, string>>,
  mediaDir: string | undefined,
): string | null {
  const registered = sources[assetId];
  if (registered && fileExists(registered)) return registered;
  if (mediaDir) {
    const displayName =
      isRecord(asset) && typeof asset['displayName'] === 'string' ? asset['displayName'] : '';
    for (const name of [assetId, displayName]) {
      if (!name) continue;
      const candidate = join(mediaDir, name);
      if (fileExists(candidate)) return resolve(candidate);
    }
  }
  // The clip's asset label may itself be a path to a real file.
  if (fileExists(assetId)) return isAbsolute(assetId) ? assetId : resolve(assetId);
  return null;
}

/**
 * Decide how a project should be rendered. Projects whose clips point at no real media keep the
 * manifest-only behaviour; projects whose clips all resolve to files get real video; a mix is an
 * error, because a video with silent holes would claim more than it delivers.
 */
export function planMedia(
  project: unknown,
  options: { manifestOnly: boolean; mediaDir?: string | undefined },
  fallback: PresetFallback,
): MediaPlan {
  if (options.manifestOnly) {
    return { mode: 'manifest-only', reason: '--manifest-only was given.' };
  }
  if (!isRecord(project)) return { mode: 'manifest-only', reason: 'No project document.' };
  const compositions = project['compositions'];
  const rootId = project['rootCompositionId'];
  const root =
    isRecord(compositions) && typeof rootId === 'string' ? compositions[rootId] : undefined;
  if (!isRecord(root) || !Array.isArray(root['tracks'])) {
    return { mode: 'manifest-only', reason: 'The project has no timeline.' };
  }
  const assets = isRecord(project['assets']) ? project['assets'] : {};
  const sources = loadAssetSources();

  const warnings: string[] = [];
  const pending: Array<{
    clip: Record<string, unknown>;
    clipId: string;
    trackId: string;
    assetId: string;
    path: string | null;
    /** A real media asset (project record or CLI-registered file), not a bare label. */
    real: boolean;
  }> = [];

  for (const rawTrack of root['tracks'] as unknown[]) {
    if (!isRecord(rawTrack) || rawTrack['enabled'] === false) continue;
    const trackId = typeof rawTrack['id'] === 'string' ? rawTrack['id'] : '?';
    const clips = Array.isArray(rawTrack['clips']) ? rawTrack['clips'] : [];
    for (const rawClip of clips as unknown[]) {
      if (!isRecord(rawClip)) continue;
      const clipId = typeof rawClip['id'] === 'string' ? rawClip['id'] : '?';
      if (rawClip['kind'] !== 'video' || typeof rawClip['assetId'] !== 'string') {
        warnings.push(
          `Clip "${clipId}" is a ${String(rawClip['kind'])} clip; the CLI renderer only draws video, image and audio clips, so it is left out.`,
        );
        continue;
      }
      const assetId = rawClip['assetId'];
      pending.push({
        clip: rawClip,
        clipId,
        trackId,
        assetId,
        path: resolveSource(assetId, assets[assetId], sources, options.mediaDir),
        real: sources[assetId] !== undefined || isRecord(assets[assetId]),
      });
    }
  }

  if (pending.length === 0) {
    return { mode: 'manifest-only', reason: 'The timeline has no video clips.' };
  }
  const unresolved = pending.filter((p) => p.path === null);
  // Bare labels (no asset record, no registered file) keep the manifest-only behaviour. A REAL
  // asset whose file is missing must fail loudly instead of quietly rendering nothing.
  if (unresolved.length === pending.length && !unresolved.some((p) => p.real)) {
    return {
      mode: 'manifest-only',
      reason: 'No clip points at a media file on this machine.',
    };
  }
  if (unresolved.length > 0) {
    const ids = [...new Set(unresolved.map((p) => p.assetId))];
    const describe = (id: string): string =>
      sources[id] ? `"${id}" (was ${sources[id]})` : `"${id}"`;
    return {
      mode: 'error',
      code: 'media-missing',
      message:
        `Cannot render: no media file found for ${ids.map(describe).join(', ')}. ` +
        'Add clips with a real file (`joy-media timeline add-clip --asset <file>`), pass ' +
        '--media-dir <folder> holding the files, or use --manifest-only for the plan alone.',
    };
  }

  const clips: MediaClip[] = [];
  for (const entry of pending) {
    const path = entry.path as string;
    const info = probeMedia(path);
    if (!info) {
      return {
        mode: 'error',
        code: 'media-unreadable',
        message:
          `Cannot read "${path}" (clip "${entry.clipId}"). It is not playable media, or ffprobe ` +
          'is not installed (set JOY_MEDIA_FFPROBE to its path).',
      };
    }
    const c = entry.clip;
    const startUs = typeof c['startUs'] === 'number' ? c['startUs'] : 0;
    const durationUs = typeof c['durationUs'] === 'number' ? c['durationUs'] : 0;
    const sourceInUs = typeof c['sourceInUs'] === 'number' ? c['sourceInUs'] : 0;
    if (durationUs <= 0) continue;
    if (typeof c['playbackRate'] === 'number' && c['playbackRate'] !== 1) {
      warnings.push(
        `Clip "${entry.clipId}": playback rate ${c['playbackRate']}x is not supported by the CLI renderer; drawn at 1x.`,
      );
    }
    if (c['reversed'] === true || isRecord(c['timeRemap'])) {
      warnings.push(
        `Clip "${entry.clipId}": reverse / time remap is not supported by the CLI renderer; drawn forward at 1x.`,
      );
    }
    if (
      !info.isImage &&
      info.durationUs > 0 &&
      sourceInUs + durationUs > info.durationUs + 50_000
    ) {
      warnings.push(
        `Clip "${entry.clipId}" runs past the end of its source (${(info.durationUs / 1e6).toFixed(2)}s long); the rest is left empty.`,
      );
    }
    clips.push({
      clipId: entry.clipId,
      trackId: entry.trackId,
      startUs,
      durationUs,
      sourceInUs,
      assetId: entry.assetId,
      sourcePath: path,
      info,
      visual: info.hasVideo,
      audio: info.hasAudio && !info.isImage,
    });
  }
  if (clips.length === 0) return { mode: 'manifest-only', reason: 'All clips have zero length.' };

  const rawFps = isRecord(root['frameRate']) ? root['frameRate'] : undefined;
  const num = typeof rawFps?.['num'] === 'number' ? rawFps['num'] : 0;
  const den = typeof rawFps?.['den'] === 'number' ? rawFps['den'] : 0;
  const width =
    typeof root['width'] === 'number' && root['width'] > 0 ? root['width'] : fallback.width;
  const height =
    typeof root['height'] === 'number' && root['height'] > 0 ? root['height'] : fallback.height;
  return {
    mode: 'media',
    clips,
    width: even(Math.round(width)),
    height: even(Math.round(height)),
    fps: num > 0 && den > 0 ? `${num}/${den}` : `${fallback.fps}/1`,
    durationUs: Math.max(...clips.map((c) => c.startUs + c.durationUs)),
    warnings,
  };
}

const secs = (us: number): string => (us / 1_000_000).toFixed(6);

const CODEC_ARGS: Readonly<Record<MediaPresetId, readonly string[]>> = {
  mp4: [
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
  ],
  webm: [
    '-c:v',
    'libvpx-vp9',
    '-b:v',
    '0',
    '-crf',
    '32',
    '-row-mt',
    '1',
    '-c:a',
    'libopus',
    '-b:a',
    '128k',
  ],
  prores: ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s24le'],
};
const FORMAT: Readonly<Record<MediaPresetId, string>> = { mp4: 'mp4', webm: 'webm', prores: 'mov' };

/** The full ffmpeg argument list for one render (one input per clip, one filter graph). */
export function buildFfmpegArgs(
  plan: MediaPlanReady,
  preset: MediaPresetId,
  outputPath: string,
): string[] {
  const { width: W, height: H, fps: FPS } = plan;
  const total = secs(plan.durationUs);
  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-progress',
    'pipe:1',
    '-nostats',
  ];
  const filters: string[] = [`color=c=black:s=${W}x${H}:r=${FPS}:d=${total},format=yuv420p[b0]`];
  const audioLabels: string[] = [];
  let base = 0;

  plan.clips.forEach((clip, i) => {
    const start = secs(clip.startUs);
    const end = secs(clip.startUs + clip.durationUs);
    const dur = secs(clip.durationUs);
    const from = secs(clip.sourceInUs);
    if (clip.info.isImage) args.push('-loop', '1', '-framerate', FPS, '-t', dur);
    args.push('-i', clip.sourcePath);

    if (clip.visual) {
      const trim = clip.info.isImage
        ? ''
        : `trim=start=${from}:duration=${dur},setpts=PTS-STARTPTS,fps=${FPS},`;
      const fit =
        `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`;
      filters.push(`[${i}:v]${trim}${fit},setpts=PTS-STARTPTS+${start}/TB[v${i}]`);
      filters.push(
        `[b${base}][v${i}]overlay=x=0:y=0:eof_action=pass:enable='between(t,${start},${end})'[b${base + 1}]`,
      );
      base += 1;
    }
    if (clip.audio) {
      const ms = Math.round(clip.startUs / 1000);
      filters.push(
        `[${i}:a]atrim=start=${from}:duration=${dur},asetpts=PTS-STARTPTS,aresample=48000,` +
          `aformat=sample_fmts=fltp:channel_layouts=stereo${ms > 0 ? `,adelay=${ms}|${ms}` : ''}[a${i}]`,
      );
      audioLabels.push(`[a${i}]`);
    }
  });

  if (audioLabels.length === 0) {
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${total}[aout]`);
  } else if (audioLabels.length === 1) {
    filters.push(`${audioLabels[0]}apad=whole_dur=${total},atrim=0:${total}[aout]`);
  } else {
    filters.push(
      `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0:dropout_transition=0,` +
        `apad=whole_dur=${total},atrim=0:${total}[aout]`,
    );
  }

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    `[b${base}]`,
    '-map',
    '[aout]',
    '-t',
    total,
    ...CODEC_ARGS[preset],
    '-f',
    FORMAT[preset],
    outputPath,
  );
  return args;
}

export interface EncodeHandle {
  readonly done: Promise<
    | { ok: true }
    | { ok: false; message: string; code: 'ffmpeg-missing' | 'encode-failed' | 'cancelled' }
  >;
  cancel(): void;
}

/** Run ffmpeg. `onProgress` gets 0..1 as the encoder advances through the timeline. */
export function startEncode(
  args: readonly string[],
  durationUs: number,
  onProgress: (fraction: number) => void,
): EncodeHandle {
  const child = spawn(ffmpegBinary(), [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let cancelled = false;
  let stderrTail = '';
  let pending = '';

  child.stdout.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      const match = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
      if (match && durationUs > 0) onProgress(Math.min(1, Number(match[1]) / durationUs));
      newline = pending.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
  });

  const done = new Promise<Awaited<EncodeHandle['done']>>((resolvePromise) => {
    child.on('error', (err: NodeJS.ErrnoException) => {
      resolvePromise({
        ok: false,
        code: 'ffmpeg-missing',
        message:
          err.code === 'ENOENT'
            ? `ffmpeg was not found (looked for "${ffmpegBinary()}"). Install ffmpeg or set JOY_MEDIA_FFMPEG to its path.`
            : `Could not start ffmpeg: ${err.message}`,
      });
    });
    child.on('close', (code) => {
      if (cancelled) {
        resolvePromise({ ok: false, code: 'cancelled', message: 'Render cancelled.' });
      } else if (code === 0) {
        resolvePromise({ ok: true });
      } else {
        resolvePromise({
          ok: false,
          code: 'encode-failed',
          message: `ffmpeg failed (exit ${code}): ${stderrTail.trim().split('\n').slice(-6).join(' | ') || 'no error output'}`,
        });
      }
    });
  });

  return {
    done,
    cancel: () => {
      cancelled = true;
      child.kill('SIGKILL');
    },
  };
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
