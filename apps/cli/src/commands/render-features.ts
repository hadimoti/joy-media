/* global process */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ffmpegBinary, ffprobeBinary } from '../utils/media-probe.js';

// ---------------------------------------------------------------------------
// Renderer refusal fragments (shared verbatim with render-media.ts)
// ---------------------------------------------------------------------------

export const RF_VISUAL_OBJECTS = 'visual objects, transforms, and effects';
export const RF_PROPERTY_ANIMATIONS = 'property animations';
export const RF_CLIP_COLOR_GRADES = 'clip color grades';
export const RF_COLOR_GRADING = 'color grading';
export const RF_AUDIO_EFFECTS = 'audio effects';
export const RF_AUDIO_BUS_ROUTING = 'audio bus routing';
export const RF_AUDIO_BUS_GAIN = 'audio bus gain';
export const RF_AUDIO_BUS_PAN = 'audio bus pan';
export const RF_AUDIO_BUS_MUTE = 'audio bus mute';
export const RF_AUDIO_BUS_SOLO = 'audio bus solo';
export const RF_AUDIO_PAN = 'audio pan on clip';
export const RF_AUDIO_SOLO = 'audio solo on clip';
export const RF_PROCESSED_AUDIO = 'processed audio source on clip';
export const RF_TRACK_MUTE_SOLO = 'uses mute or solo, which the CLI renderer does not support';
export const RF_ALPHA = 'uses alpha-bearing media';
export const RF_PLAYBACK_RATE = 'playback rate';
export const RF_REVERSE_TIME_REMAP = 'reverse / time remap';
export const RF_NOT_VIDEO_CLIP = 'the CLI renderer only supports video clips';
export const RF_TRANSITION_TYPE = 'only dissolve is rendered';
export const RF_CAPTION_STYLE = 'has its own style, which the CLI renderer does not draw yet';
export const RF_CAPTION_STYLE_OR_ANIMATION =
  'uses a caption style or animation, which the CLI renderer does not draw';
export const RF_CAPTION_RTL = 'is right-to-left, which the CLI renderer does not draw yet';
export const RF_DISSOLVE_HANDLE = 'for its dissolve, and its source';
export const RF_AUDIO_GAIN_RANGE = 'must be a number from 0 to';
export const RF_AUDIO_FADE_RANGE = 'must be zero or more microseconds';

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
  'render.audio-bus-settings',
  'render.audio-pan',
  'render.audio-solo',
  'render.track-mute-solo',
  'render.audio-processed-source',
  'captions.drawtext',
  'captions.styling',
  'captions.rtl',
  'transitions.dissolve',
  'transitions.other',
  'audio.gain',
  'audio.fades',
  'audio.mute',
] as const satisfies readonly string[];

export type FeatureId = (typeof FEATURE_IDS)[number];

export const REASON_CAPTION_FONT_MISSING =
  'Captions need a font file, and none was found. Set JOY_MEDIA_CAPTION_FONT to a .ttf or .otf file.';

// ---------------------------------------------------------------------------
// Feature descriptor
// ---------------------------------------------------------------------------

export type FeatureStatus = 'available' | 'setup-required' | 'unsupported' | 'unknown';

export interface FeatureEntry {
  readonly id: FeatureId;
  readonly area: string;
  readonly status: FeatureStatus;
  readonly reason: string;
  readonly refusal: readonly string[];
}

export interface FeatureProbes {
  readonly ffmpeg: boolean;
  readonly ffprobe: boolean;
  readonly captionFont: boolean;
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

/** Caption font search shared with render-media.ts. */
export function captionFontFile(): string | null {
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

/** The static catalog: what the product supports, before this machine is probed. */
export function baseFeatureList(): FeatureEntry[] {
  return [
    {
      id: 'render.real-media',
      area: 'render',
      status: 'available',
      reason: 'Ordinary video, still images, and audio clips on enabled tracks.',
      refusal: [],
    },
    {
      id: 'render.frame-rate.ntsc-and-fraction',
      area: 'frame-rate',
      status: 'available',
      reason:
        'NTSC rates (23.976, 29.97, 59.94) and exact fractions (e.g. 30000/1001) are supported.',
      refusal: [],
    },
    {
      id: 'render.alpha-media',
      area: 'render',
      status: 'unsupported',
      reason: 'Clips with alpha-bearing media are refused.',
      refusal: [RF_ALPHA],
    },
    {
      id: 'render.playback-rate',
      area: 'render',
      status: 'unsupported',
      reason: 'Clips with playback-rate changes are refused.',
      refusal: [RF_PLAYBACK_RATE],
    },
    {
      id: 'render.freeze-frame',
      area: 'render',
      status: 'unsupported',
      reason:
        'The CLI project format has no freeze-frame model; any playback-rate change, including zero, is refused.',
      refusal: [RF_PLAYBACK_RATE],
    },
    {
      id: 'render.reverse',
      area: 'render',
      status: 'unsupported',
      reason: 'Clips with reverse playback are refused.',
      refusal: [RF_REVERSE_TIME_REMAP],
    },
    {
      id: 'render.time-remap',
      area: 'render',
      status: 'unsupported',
      reason: 'Clips with time remapping are refused.',
      refusal: [RF_REVERSE_TIME_REMAP],
    },
    {
      id: 'render.nested-composition',
      area: 'render',
      status: 'unsupported',
      reason: 'Nested compositions are refused as non-video clips.',
      refusal: [RF_NOT_VIDEO_CLIP],
    },
    {
      id: 'render.visual-objects',
      area: 'render',
      status: 'unsupported',
      reason: RF_VISUAL_OBJECTS,
      refusal: [RF_VISUAL_OBJECTS],
    },
    {
      id: 'render.property-animations',
      area: 'render',
      status: 'unsupported',
      reason: RF_PROPERTY_ANIMATIONS,
      refusal: [RF_PROPERTY_ANIMATIONS],
    },
    {
      id: 'render.color-grade',
      area: 'render',
      status: 'unsupported',
      reason: 'Color grading and clip color grades are refused.',
      refusal: [RF_COLOR_GRADING, RF_CLIP_COLOR_GRADES],
    },
    {
      id: 'render.audio-effects',
      area: 'audio',
      status: 'unsupported',
      reason: RF_AUDIO_EFFECTS,
      refusal: [RF_AUDIO_EFFECTS],
    },
    {
      id: 'render.audio-bus-routing',
      area: 'audio',
      status: 'unsupported',
      reason: RF_AUDIO_BUS_ROUTING,
      refusal: [RF_AUDIO_BUS_ROUTING],
    },
    {
      id: 'render.audio-bus-settings',
      area: 'audio',
      status: 'unsupported',
      reason:
        'Audio bus gain, pan, mute and solo are not supported by the CLI renderer; only the default bus is rendered.',
      refusal: [RF_AUDIO_BUS_GAIN, RF_AUDIO_BUS_PAN, RF_AUDIO_BUS_MUTE, RF_AUDIO_BUS_SOLO],
    },
    {
      id: 'render.audio-pan',
      area: 'audio',
      status: 'unsupported',
      reason: RF_AUDIO_PAN,
      refusal: [RF_AUDIO_PAN],
    },
    {
      id: 'render.audio-solo',
      area: 'audio',
      status: 'unsupported',
      reason: RF_AUDIO_SOLO,
      refusal: [RF_AUDIO_SOLO],
    },
    {
      id: 'render.track-mute-solo',
      area: 'render',
      status: 'unsupported',
      reason: RF_TRACK_MUTE_SOLO,
      refusal: [RF_TRACK_MUTE_SOLO],
    },
    {
      id: 'render.audio-processed-source',
      area: 'audio',
      status: 'unsupported',
      reason: RF_PROCESSED_AUDIO,
      refusal: [RF_PROCESSED_AUDIO],
    },
    {
      id: 'captions.drawtext',
      area: 'captions',
      status: 'available',
      reason: 'Captions render with ffmpeg drawtext when a caption font is available.',
      refusal: [],
    },
    {
      id: 'captions.styling',
      area: 'captions',
      status: 'unsupported',
      reason: 'Caption clips with their own style or a referenced style or animation are refused.',
      refusal: [RF_CAPTION_STYLE, RF_CAPTION_STYLE_OR_ANIMATION],
    },
    {
      id: 'captions.rtl',
      area: 'captions',
      status: 'unsupported',
      reason: 'Right-to-left caption documents are refused.',
      refusal: [RF_CAPTION_RTL],
    },
    {
      id: 'transitions.dissolve',
      area: 'transitions',
      status: 'available',
      reason:
        "Dissolves render between touching clips when each clip has handle media beyond its edge; otherwise the render refuses with a message containing 'for its dissolve, and its source'.",
      refusal: [],
    },
    {
      id: 'transitions.other',
      area: 'transitions',
      status: 'unsupported',
      reason: RF_TRANSITION_TYPE,
      refusal: [RF_TRANSITION_TYPE],
    },
    {
      id: 'audio.gain',
      area: 'audio',
      status: 'available',
      reason: 'Clip gain must be a number from 0 to 4 (0 to +12 dB); other values are refused.',
      refusal: [],
    },
    {
      id: 'audio.fades',
      area: 'audio',
      status: 'available',
      reason: 'Fade-in and fade-out must be zero or more microseconds; other values are refused.',
      refusal: [],
    },
    {
      id: 'audio.mute',
      area: 'audio',
      status: 'available',
      reason: 'Clip mute is rendered.',
      refusal: [],
    },
  ];
}

/** Apply environment probes without mutating the feature descriptors. */
export function applyProbes(
  features: readonly FeatureEntry[],
  probes: FeatureProbes,
): FeatureEntry[] {
  const missing: string[] = [];
  if (!probes.ffmpeg) missing.push('ffmpeg');
  if (!probes.ffprobe) missing.push('ffprobe');
  const missingReason = missing
    .map(
      (binary) =>
        `${binary} is not found; install it or set JOY_MEDIA_${binary.toUpperCase()} (see the render requirements)`,
    )
    .join('; ');
  return features.map((feature) => {
    if (feature.status !== 'available') return { ...feature };
    if (feature.id === 'captions.drawtext' && !probes.captionFont) {
      const reason =
        missing.length > 0
          ? `${missingReason}; ${REASON_CAPTION_FONT_MISSING}`
          : REASON_CAPTION_FONT_MISSING;
      return { ...feature, status: 'setup-required', reason };
    }
    if (missing.length > 0) {
      return { ...feature, status: 'setup-required', reason: missingReason };
    }
    return { ...feature };
  });
}

/** Build the catalog using the real ffmpeg, ffprobe and caption-font probes. */
export function buildFeatureList(): FeatureEntry[] {
  return applyProbes(baseFeatureList(), {
    ffmpeg: binaryAvailable(ffmpegBinary()),
    ffprobe: binaryAvailable(ffprobeBinary()),
    captionFont: captionFontFile() !== null,
  });
}
