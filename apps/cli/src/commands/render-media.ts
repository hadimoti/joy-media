/* global Buffer */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { loadAssetSources } from '../utils/asset-sources.js';
import { ffmpegBinary, probeMedia, type MediaInfo } from '../utils/media-probe.js';
import {
  RF_ALPHA,
  RF_AUDIO_BUS_GAIN,
  RF_AUDIO_BUS_MUTE,
  RF_AUDIO_BUS_PAN,
  RF_AUDIO_BUS_ROUTING,
  RF_AUDIO_BUS_SOLO,
  RF_AUDIO_EFFECTS,
  RF_AUDIO_FADE_RANGE,
  RF_AUDIO_GAIN_RANGE,
  RF_AUDIO_PAN,
  RF_AUDIO_SOLO,
  RF_CAPTION_RTL,
  RF_CAPTION_STYLE,
  RF_CAPTION_STYLE_OR_ANIMATION,
  RF_CLIP_COLOR_GRADES,
  RF_COLOR_GRADING,
  RF_DISSOLVE_HANDLE,
  RF_NOT_VIDEO_CLIP,
  RF_PLAYBACK_RATE,
  RF_PROCESSED_AUDIO,
  RF_PROPERTY_ANIMATIONS,
  RF_REVERSE_TIME_REMAP,
  RF_TRACK_MUTE_SOLO,
  RF_TRANSITION_TYPE,
  RF_VISUAL_OBJECTS,
  captionFontFile,
  REASON_CAPTION_FONT_MISSING,
} from './render-features.js';

/**
 * Real media rendering for `joy-media render`: turn the project's timeline into one video file
 * with ffmpeg. Scope (v1): video/image/audio clips on enabled tracks, placed at their start time,
 * trimmed by `sourceInUs`, later tracks drawn on top of earlier ones, all audio mixed. Anything
 * else (speed changes, reverse, nested compositions, captions, transforms, effects, color grading,
 * and non-default audio graph processing) is rejected before output instead of being silently
 * ignored. See docs/product/CLI-RENDER-SUPPORT.md for the current render boundary.
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
  readonly audioSettings: ClipAudioSettings;
  /** Length of the dissolve this clip fades in over (0 when none). */
  readonly transitionInUs: number;
  /** Length of the dissolve this clip fades out of (0 when none). */
  readonly transitionOutUs: number;
}

/** One caption line on screen, in timeline time. */
export interface CaptionCue {
  readonly text: string;
  readonly startUs: number;
  readonly endUs: number;
}

export interface MediaPlanReady {
  readonly mode: 'media';
  readonly clips: readonly MediaClip[];
  readonly captions: readonly CaptionCue[];
  /** Font file for captions (null when there are none). */
  readonly fontFile: string | null;
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
      readonly code: 'media-missing' | 'media-unreadable' | 'unsupported-feature';
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

/** Most gain a clip may take: +12 dB. */
const MAX_CLIP_GAIN = 4;

function validGain(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_CLIP_GAIN
  );
}

function validFade(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

/** A clip's rendered audio settings. Missing or invalid values mean unity gain, sound on, no fades. */
export interface ClipAudioSettings {
  readonly gain: number;
  readonly mute: boolean;
  readonly fadeInUs: number;
  readonly fadeOutUs: number;
}

function clipAudioSettings(config: unknown): ClipAudioSettings {
  const record = isRecord(config) ? config : {};
  const gain = record['gain'];
  const fadeIn = record['fadeInUs'];
  const fadeOut = record['fadeOutUs'];
  return {
    gain: validGain(gain) ? gain : 1,
    mute: record['mute'] === true,
    fadeInUs: validFade(fadeIn) && typeof fadeIn === 'number' ? fadeIn : 0,
    fadeOutUs: validFade(fadeOut) && typeof fadeOut === 'number' ? fadeOut : 0,
  };
}

/** Transitions of the root composition (the place the schema stores them), plus any legacy list. */
function transitionList(project: Record<string, unknown>): Record<string, unknown>[] {
  const compositions = project['compositions'];
  const rootId = project['rootCompositionId'];
  const root =
    isRecord(compositions) && typeof rootId === 'string' ? compositions[rootId] : undefined;
  const rootList = isRecord(root) && Array.isArray(root['transitions']) ? root['transitions'] : [];
  const legacy = Array.isArray(project['transitions']) ? project['transitions'] : [];
  return [...rootList, ...legacy].filter(isRecord);
}

/** Caption cues of one caption clip, or the reason the renderer cannot draw them. */
function captionCuesOf(
  project: Record<string, unknown>,
  clip: Record<string, unknown>,
): CaptionCue[] | string {
  const clipId = String(clip['id']);
  if (clip['style'] !== undefined) {
    return `Caption clip "${clipId}" ${RF_CAPTION_STYLE}.`;
  }
  const docs = isRecord(project['captionDocuments']) ? project['captionDocuments'] : {};
  const doc = docs[String(clip['captionDocumentId'])];
  if (!isRecord(doc)) return `Caption clip "${clipId}" refers to a missing caption document.`;
  if (doc['styleRef'] !== undefined || doc['animationRef'] !== undefined) {
    return `Caption clip "${clipId}" ${RF_CAPTION_STYLE_OR_ANIMATION}.`;
  }
  if (doc['direction'] === 'rtl') {
    return `Caption clip "${clipId}" ${RF_CAPTION_RTL}.`;
  }
  const words: Record<string, unknown> = isRecord(doc['words']) ? doc['words'] : {};
  const segments = Array.isArray(doc['segments']) ? doc['segments'] : [];
  const clipStart = typeof clip['startUs'] === 'number' ? clip['startUs'] : 0;
  const clipLength = typeof clip['durationUs'] === 'number' ? clip['durationUs'] : 0;
  const cues: CaptionCue[] = [];
  for (const segment of segments) {
    if (!isRecord(segment)) continue;
    const start = Number(segment['startUs']);
    const end = Math.min(Number(segment['endUs']), clipLength);
    if (!(end > start)) continue;
    const text =
      typeof segment['textOverride'] === 'string'
        ? segment['textOverride']
        : (Array.isArray(segment['wordIds']) ? segment['wordIds'] : [])
            .map((id) => {
              const word = words[String(id)];
              return isRecord(word) ? String(word['text']) : '';
            })
            .filter((word) => word !== '')
            .join(' ');
    if (text.trim() === '') continue;
    cues.push({ text, startUs: clipStart + start, endUs: clipStart + end });
  }
  return cues;
}

/** Escape a value for an ffmpeg filter option: separators and quotes need a backslash. */
function filterValue(value: string): string {
  return value.replace(/[\\:,;'[\]%]/g, '\\$&');
}

function unsupportedProjectFeature(project: Record<string, unknown>): string | null {
  const visualObjects = project['visualObjects'];
  if (isRecord(visualObjects) && Object.keys(visualObjects).length > 0) return RF_VISUAL_OBJECTS;
  const unsupportedTransition = transitionList(project).find((t) => t['type'] !== 'dissolve');
  if (unsupportedTransition)
    return `transition type "${String(unsupportedTransition['type'])}" (${RF_TRANSITION_TYPE})`;
  if (
    isRecord(project['propertyAnimations']) &&
    Object.keys(project['propertyAnimations']).length > 0
  )
    return RF_PROPERTY_ANIMATIONS;
  if (isRecord(project['clipColorGrades']) && Object.keys(project['clipColorGrades']).length > 0)
    return RF_CLIP_COLOR_GRADES;
  if (project['colorGrade'] !== undefined) return RF_COLOR_GRADING;

  const audio = project['audio'];
  if (!isRecord(audio)) return null;
  const audioClips = isRecord(audio['clips']) ? audio['clips'] : {};
  for (const [clipId, rawConfig] of Object.entries(audioClips)) {
    if (!isRecord(rawConfig)) continue;
    if (rawConfig['sourceAssetId'] !== undefined) return `${RF_PROCESSED_AUDIO} "${clipId}"`;
    // Gain, mute and fades are rendered (see clipAudioSettings); only the rest is refused here.
    if (rawConfig['gain'] !== undefined && !validGain(rawConfig['gain']))
      return `audio gain on clip "${clipId}" ${RF_AUDIO_GAIN_RANGE} ${MAX_CLIP_GAIN}`;
    if (!validFade(rawConfig['fadeInUs']) || !validFade(rawConfig['fadeOutUs']))
      return `audio fades on clip "${clipId}" ${RF_AUDIO_FADE_RANGE}`;
    if (rawConfig['pan'] !== undefined && rawConfig['pan'] !== 0)
      return `${RF_AUDIO_PAN} "${clipId}"`;
    if (rawConfig['solo'] === true) return `${RF_AUDIO_SOLO} "${clipId}"`;
  }
  if (Array.isArray(audio['effects']) && audio['effects'].length > 0) return RF_AUDIO_EFFECTS;
  const buses = Array.isArray(audio['buses']) ? audio['buses'] : [];
  if (buses.length > 1) return RF_AUDIO_BUS_ROUTING;
  for (const rawBus of buses) {
    if (!isRecord(rawBus)) continue;
    if (rawBus['gain'] !== undefined && rawBus['gain'] !== 1) return RF_AUDIO_BUS_GAIN;
    if (rawBus['pan'] !== undefined && rawBus['pan'] !== 0) return RF_AUDIO_BUS_PAN;
    if (rawBus['mute'] === true) return RF_AUDIO_BUS_MUTE;
    if (rawBus['solo'] === true) return RF_AUDIO_BUS_SOLO;
    if (Array.isArray(rawBus['inputs']) && rawBus['inputs'].length > 0) return RF_AUDIO_BUS_ROUTING;
  }
  return null;
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
  const unsupported = unsupportedProjectFeature(project);
  // Dissolve lengths by clip: `dissolveIn` for the clip a dissolve comes into, `dissolveOut` for the one it leaves.
  const dissolveIn = new Map<string, number>();
  const dissolveOut = new Map<string, number>();
  for (const transition of transitionList(project)) {
    if (transition['type'] !== 'dissolve' || typeof transition['durationUs'] !== 'number') continue;
    if (typeof transition['leftClipId'] === 'string')
      dissolveOut.set(transition['leftClipId'], transition['durationUs']);
    if (typeof transition['rightClipId'] === 'string')
      dissolveIn.set(transition['rightClipId'], transition['durationUs']);
  }
  const audioConfigs =
    isRecord(project['audio']) && isRecord(project['audio']['clips'])
      ? project['audio']['clips']
      : {};
  if (unsupported) {
    return {
      mode: 'error',
      code: 'unsupported-feature',
      message: `The CLI renderer does not support ${unsupported}; no media was produced.`,
    };
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

  const captions: CaptionCue[] = [];
  for (const rawTrack of root['tracks'] as unknown[]) {
    if (!isRecord(rawTrack) || rawTrack['enabled'] === false) continue;
    const trackId = typeof rawTrack['id'] === 'string' ? rawTrack['id'] : '?';
    if (rawTrack['muted'] === true || rawTrack['solo'] === true) {
      return {
        mode: 'error',
        code: 'unsupported-feature',
        message: `Track "${trackId}" ${RF_TRACK_MUTE_SOLO}.`,
      };
    }
    const clips = Array.isArray(rawTrack['clips']) ? rawTrack['clips'] : [];
    for (const rawClip of clips as unknown[]) {
      if (!isRecord(rawClip)) continue;
      const clipId = typeof rawClip['id'] === 'string' ? rawClip['id'] : '?';
      if (rawClip['kind'] === 'caption') {
        const read = captionCuesOf(project, rawClip);
        if (typeof read === 'string')
          return { mode: 'error', code: 'unsupported-feature', message: read };
        captions.push(...read);
        continue;
      }
      if (rawClip['kind'] !== 'video' || typeof rawClip['assetId'] !== 'string') {
        return {
          mode: 'error',
          code: 'unsupported-feature',
          message: `Clip "${clipId}" is a ${String(rawClip['kind'])} clip; ${RF_NOT_VIDEO_CLIP}.`,
        };
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

  const fontFile = captions.length > 0 ? captionFontFile() : null;
  if (captions.length > 0 && fontFile === null) {
    return {
      mode: 'error',
      code: 'unsupported-feature',
      message: REASON_CAPTION_FONT_MISSING,
    };
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
    if (info.hasAlpha) {
      return {
        mode: 'error',
        code: 'unsupported-feature',
        message: `Clip "${entry.clipId}" ${RF_ALPHA}; the CLI renderer cannot preserve transparency.`,
      };
    }
    const c = entry.clip;
    const startUs = typeof c['startUs'] === 'number' ? c['startUs'] : 0;
    const durationUs = typeof c['durationUs'] === 'number' ? c['durationUs'] : 0;
    const sourceInUs = typeof c['sourceInUs'] === 'number' ? c['sourceInUs'] : 0;
    if (durationUs <= 0) continue;
    if (typeof c['playbackRate'] === 'number' && c['playbackRate'] !== 1) {
      return {
        mode: 'error',
        code: 'unsupported-feature',
        message: `Clip "${entry.clipId}": ${RF_PLAYBACK_RATE} ${c['playbackRate']}x is not supported by the CLI renderer.`,
      };
    }
    if (c['reversed'] === true || isRecord(c['timeRemap'])) {
      return {
        mode: 'error',
        code: 'unsupported-feature',
        message: `Clip "${entry.clipId}": ${RF_REVERSE_TIME_REMAP} is not supported by the CLI renderer.`,
      };
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
    const transitionInUs = dissolveIn.get(entry.clipId) ?? 0;
    const transitionOutUs = dissolveOut.get(entry.clipId) ?? 0;
    // A dissolve takes half its length from the media beyond each edge of the junction.
    // A real clip whose source has no such media cannot be dissolved; stills can always be held.
    if (!info.isImage && info.durationUs > 0) {
      if (
        transitionOutUs > 0 &&
        sourceInUs + durationUs + transitionOutUs / 2 > info.durationUs + 50_000
      ) {
        return {
          mode: 'error',
          code: 'unsupported-feature',
          message: `Clip "${entry.clipId}" needs ${(transitionOutUs / 2_000_000).toFixed(2)} s more media after its end ${RF_DISSOLVE_HANDLE} ends first.`,
        };
      }
    }
    if (!info.isImage && transitionInUs > 0 && sourceInUs < transitionInUs / 2) {
      return {
        mode: 'error',
        code: 'unsupported-feature',
        message: `Clip "${entry.clipId}" needs ${(transitionInUs / 2_000_000).toFixed(2)} s more media before its start ${RF_DISSOLVE_HANDLE} begins there.`,
      };
    }
    clips.push({
      clipId: entry.clipId,
      transitionInUs,
      transitionOutUs,
      trackId: entry.trackId,
      startUs,
      durationUs,
      sourceInUs,
      assetId: entry.assetId,
      sourcePath: path,
      info,
      visual: info.hasVideo,
      audio: info.hasAudio && !info.isImage,
      audioSettings: clipAudioSettings(audioConfigs[entry.clipId]),
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
    captions,
    fontFile,
    width: even(Math.round(width)),
    height: even(Math.round(height)),
    fps: num > 0 && den > 0 ? `${num}/${den}` : `${fallback.fps}/1`,
    durationUs: Math.max(
      ...clips.map((c) => c.startUs + c.durationUs),
      ...captions.map((cue) => cue.endUs),
    ),
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

  const trackRank = new Map<string, number>();
  for (const clip of plan.clips) {
    if (!trackRank.has(clip.trackId)) trackRank.set(clip.trackId, trackRank.size);
  }
  const ordered = [...plan.clips].sort(
    (a, b) =>
      (trackRank.get(a.trackId) ?? 0) - (trackRank.get(b.trackId) ?? 0) || a.startUs - b.startUs,
  );
  ordered.forEach((clip, i) => {
    const dur = secs(clip.durationUs);
    const from = secs(clip.sourceInUs);
    if (clip.info.isImage) {
      const heldUs = clip.durationUs + clip.transitionInUs / 2 + clip.transitionOutUs / 2;
      args.push('-loop', '1', '-framerate', FPS, '-t', secs(heldUs));
    }
    args.push('-i', clip.sourcePath);

    if (clip.visual) {
      // A dissolve reaches half its length past each edge of the clip, so the junction blends
      // the outgoing clip's tail with the incoming clip's pre-roll.
      const preUs = clip.transitionInUs / 2;
      const postUs = clip.transitionOutUs / 2;
      const visibleStart = secs(clip.startUs - preUs);
      const visibleEnd = secs(clip.startUs + clip.durationUs + postUs);
      const trim = clip.info.isImage
        ? ''
        : `trim=start=${secs(clip.sourceInUs - preUs)}:duration=${secs(clip.durationUs + preUs + postUs)},setpts=PTS-STARTPTS,fps=${FPS},`;
      const fit =
        `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`;
      // The incoming clip fades in over the dissolve. Its timestamps here still start at the pre-roll.
      const dissolveIn =
        clip.transitionInUs > 0
          ? `,format=yuva420p,fade=t=in:st=0:d=${secs(clip.transitionInUs)}:alpha=1`
          : '';
      filters.push(
        `[${i}:v]${trim}${fit}${dissolveIn},setpts=PTS-STARTPTS+${visibleStart}/TB[v${i}]`,
      );
      filters.push(
        `[b${base}][v${i}]overlay=x=0:y=0:eof_action=pass:enable='between(t,${visibleStart},${visibleEnd})'[b${base + 1}]`,
      );
      base += 1;
    }
    if (clip.audio) {
      const ms = Math.round(clip.startUs / 1000);
      // Gain, mute and fades act on the clip's own timeline, before it is delayed onto the timeline.
      const { gain, mute, fadeInUs, fadeOutUs } = clip.audioSettings;
      const fadeIn = Math.min(fadeInUs, clip.durationUs);
      const fadeOut = Math.min(fadeOutUs, clip.durationUs - fadeIn);
      const shaping = [
        mute ? 'volume=0' : gain !== 1 ? `volume=${gain}:precision=float` : '',
        fadeIn > 0 ? `afade=t=in:st=0:d=${secs(fadeIn)}` : '',
        fadeOut > 0 ? `afade=t=out:st=${secs(clip.durationUs - fadeOut)}:d=${secs(fadeOut)}` : '',
      ]
        .filter((f) => f !== '')
        .map((f) => `,${f}`)
        .join('');
      filters.push(
        `[${i}:a]atrim=start=${from}:duration=${dur},asetpts=PTS-STARTPTS,aresample=48000,` +
          `aformat=sample_fmts=fltp:channel_layouts=stereo${shaping}${ms > 0 ? `,adelay=${ms}|${ms}` : ''}[a${i}]`,
      );
      audioLabels.push(`[a${i}]`);
    }
  });

  plan.captions.forEach((cue) => {
    // Option values are escaped twice: once for the filter graph and once for the drawtext option.
    const fontfile = filterValue(filterValue((plan.fontFile ?? '').replace(/\\/g, '/')));
    filters.push(
      `[b${base}]drawtext=fontfile=${fontfile}:text=${filterValue(filterValue(cue.text))}:x=(w-text_w)/2:` +
        `y=h*0.85-text_h:expansion=none:fontsize=${Math.round(H / 18)}:fontcolor=white:borderw=3:bordercolor=black:` +
        `enable='gte(t,${secs(cue.startUs)})*lt(t,${secs(cue.endUs)})'[b${base + 1}]`,
    );
    base += 1;
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
