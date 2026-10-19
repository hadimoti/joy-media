/* global process */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ffmpegBinary, ffprobeBinary } from '../utils/media-probe.js';

// ---------------------------------------------------------------------------
// Stable feature IDs
// ---------------------------------------------------------------------------

export const FEATURE_IDS = [
  'render.real-media',
  'render.frame-rate.ntsc-and-fraction',
  'render.alpha-media',
  'render.playback-rate',
  'render.freeze-frame',
  'render.reverse',
  'render.time-remap',
  'render.nested-composition',
  'render.visual-objects',
  'render.property-animations',
  'render.color-grade',
  'render.audio-effects',
  'render.audio-bus-routing',
  'render.audio-pan',
  'render.audio-solo',
  'render.track-mute-solo',
  'render.audio-processed-source',
  'captions.drawtext',
  'transitions.dissolve',
  'transitions.other',
  'audio.gain',
  'audio.fades',
  'audio.mute',
] as const satisfies readonly string[];

export type FeatureId = (typeof FEATURE_IDS)[number];

// ---------------------------------------------------------------------------
// Reason strings (shared with render-media.ts so they cannot drift)
// ---------------------------------------------------------------------------

export const REASON_VISUAL_OBJECTS = 'visual objects, transforms, and effects';
export const REASON_PROPERTY_ANIMATIONS = 'property animations';
export const REASON_AUDIO_EFFECTS = 'audio effects';
export const REASON_AUDIO_BUS_ROUTING = 'audio bus routing';
export const REASON_ALPHA_MEDIA =
  'alpha-bearing media; the CLI renderer cannot preserve transparency';
export const REASON_CAPTION_FONT_MISSING =
  'Captions need a font file, and none was found. Set JOY_MEDIA_CAPTION_FONT to a .ttf or .otf file.';
export const REASON_FFMPEG_MISSING =
  'ffmpeg was not found (looked for "%s"). Install ffmpeg or set JOY_MEDIA_FFMPEG to its path.';
export const REASON_FFPROBE_MISSING =
  'ffprobe was not found (looked for "%s"). Install ffmpeg or set JOY_MEDIA_FFPROBE to its path.';

// ---------------------------------------------------------------------------
// Feature descriptor
// ---------------------------------------------------------------------------

export type FeatureStatus = 'available' | 'setup-required' | 'unsupported' | 'unknown';

export interface FeatureEntry {
  readonly id: FeatureId;
  readonly area: string;
  readonly status: FeatureStatus;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function binaryAvailable(name: string): boolean {
  const result = spawnSync(name, ['-version'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return result.status === 0 && !result.error;
}

function ffmpegAvailable(): boolean {
  return binaryAvailable(ffmpegBinary());
}

function ffprobeAvailable(): boolean {
  return binaryAvailable(ffprobeBinary());
}

/** Duplicated from render-media.ts to avoid a circular import. */
function captionFontFile(): string | null {
  const override = process.env['JOY_MEDIA_CAPTION_FONT']?.trim();
  if (override) return existsSync(override) ? override : null;
  const candidates =
    process.platform === 'win32'
      ? [join(process.env['WINDIR'] ?? 'C:\\Windows', 'Fonts', 'arial.ttf')]
      : process.platform === 'darwin'
        ? ['/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf']
        : [
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
            '/usr/share/fonts/TTF/DejaVuSans.ttf',
          ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

function captionFontAvailable(): boolean {
  return captionFontFile() !== null;
}

// ---------------------------------------------------------------------------
// Build the feature list
// ---------------------------------------------------------------------------

export function buildFeatureList(): FeatureEntry[] {
  const features: FeatureEntry[] = [];

  // render.real-media
  const ffmpegOk = ffmpegAvailable();
  const ffprobeOk = ffprobeAvailable();
  if (ffmpegOk && ffprobeOk) {
    features.push({
      id: 'render.real-media',
      area: 'render',
      status: 'available',
      reason: 'Ordinary video, still images, and audio clips on enabled tracks.',
    });
  } else if (!ffmpegOk) {
    features.push({
      id: 'render.real-media',
      area: 'render',
      status: 'setup-required',
      reason: REASON_FFMPEG_MISSING.replace('%s', ffmpegBinary()),
    });
  } else {
    features.push({
      id: 'render.real-media',
      area: 'render',
      status: 'setup-required',
      reason: REASON_FFPROBE_MISSING.replace('%s', ffprobeBinary()),
    });
  }

  // render.frame-rate.ntsc-and-fraction
  features.push({
    id: 'render.frame-rate.ntsc-and-fraction',
    area: 'frame-rate',
    status: 'available',
    reason:
      'NTSC rates (23.976, 29.97, 59.94) and exact fractions (e.g. 30000/1001) are supported.',
  });

  // render.alpha-media
  features.push({
    id: 'render.alpha-media',
    area: 'render',
    status: 'unsupported',
    reason: REASON_ALPHA_MEDIA,
  });

  // render.playback-rate
  features.push({
    id: 'render.playback-rate',
    area: 'render',
    status: 'unsupported',
    reason: 'Playback rate changes are not supported by the CLI renderer.',
  });

  // render.freeze-frame
  features.push({
    id: 'render.freeze-frame',
    area: 'render',
    status: 'unsupported',
    reason:
      'The CLI renderer has no freeze-frame model and refuses any playback rate other than 1x.',
  });

  // render.reverse
  features.push({
    id: 'render.reverse',
    area: 'render',
    status: 'unsupported',
    reason: 'Reverse playback is not supported by the CLI renderer.',
  });

  // render.time-remap
  features.push({
    id: 'render.time-remap',
    area: 'render',
    status: 'unsupported',
    reason: 'Time remapping is not supported by the CLI renderer.',
  });

  // render.nested-composition
  features.push({
    id: 'render.nested-composition',
    area: 'render',
    status: 'unsupported',
    reason: 'Nested compositions are rejected as non-video clips.',
  });

  // render.visual-objects
  features.push({
    id: 'render.visual-objects',
    area: 'render',
    status: 'unsupported',
    reason: REASON_VISUAL_OBJECTS,
  });

  // render.property-animations
  features.push({
    id: 'render.property-animations',
    area: 'render',
    status: 'unsupported',
    reason: REASON_PROPERTY_ANIMATIONS,
  });

  // render.color-grade
  features.push({
    id: 'render.color-grade',
    area: 'render',
    status: 'unsupported',
    reason: 'color grading',
  });

  // render.audio-effects
  features.push({
    id: 'render.audio-effects',
    area: 'audio',
    status: 'unsupported',
    reason: REASON_AUDIO_EFFECTS,
  });

  // render.audio-bus-routing
  features.push({
    id: 'render.audio-bus-routing',
    area: 'audio',
    status: 'unsupported',
    reason: REASON_AUDIO_BUS_ROUTING,
  });

  // render.audio-pan
  features.push({
    id: 'render.audio-pan',
    area: 'audio',
    status: 'unsupported',
    reason: 'Audio pan is not supported by the CLI renderer.',
  });

  // render.audio-solo
  features.push({
    id: 'render.audio-solo',
    area: 'audio',
    status: 'unsupported',
    reason: 'Audio solo is not supported by the CLI renderer.',
  });

  // render.track-mute-solo
  features.push({
    id: 'render.track-mute-solo',
    area: 'render',
    status: 'unsupported',
    reason: 'Track mute and solo are not supported by the CLI renderer.',
  });

  // render.audio-processed-source
  features.push({
    id: 'render.audio-processed-source',
    area: 'audio',
    status: 'unsupported',
    reason: 'Processed audio sources are not supported by the CLI renderer.',
  });

  // captions.drawtext
  if (captionFontAvailable()) {
    features.push({
      id: 'captions.drawtext',
      area: 'captions',
      status: 'available',
      reason: 'Captions are rendered with ffmpeg drawtext when a font file is available.',
    });
  } else {
    features.push({
      id: 'captions.drawtext',
      area: 'captions',
      status: 'setup-required',
      reason: REASON_CAPTION_FONT_MISSING,
    });
  }

  // transitions.dissolve
  features.push({
    id: 'transitions.dissolve',
    area: 'transitions',
    status: 'available',
    reason: 'Dissolve transitions between touching clips are rendered.',
  });

  // transitions.other
  features.push({
    id: 'transitions.other',
    area: 'transitions',
    status: 'unsupported',
    reason: 'Only dissolve transitions are rendered.',
  });

  // audio.gain
  features.push({
    id: 'audio.gain',
    area: 'audio',
    status: 'available',
    reason: 'Clip gain from 0 to 4 (0 to +12 dB) is rendered.',
  });

  // audio.fades
  features.push({
    id: 'audio.fades',
    area: 'audio',
    status: 'available',
    reason: 'Audio fade-in and fade-out are rendered.',
  });

  // audio.mute
  features.push({
    id: 'audio.mute',
    area: 'audio',
    status: 'available',
    reason: 'Clip mute is rendered.',
  });

  return features;
}
