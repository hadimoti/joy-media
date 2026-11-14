import type { ExportPresetId } from '@joy-media/project-schema';

export interface CanvasSize {
  readonly width: number;
  readonly height: number;
}

export interface ExportAudioSettings {
  readonly codec: 'aac';
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitrate: number;
}

export type ExportPresetVideoBitrate = number | 'canvas-default' | 'canvas-high';

export interface ExportPresetDefinition {
  readonly id: ExportPresetId;
  readonly label: string;
  readonly shape: '9:16' | '4:5' | '1:1' | '16:9' | 'canvas';
  readonly size: CanvasSize | 'canvas';
  readonly frameRate: number;
  readonly videoBitrate: ExportPresetVideoBitrate;
  readonly audio: ExportAudioSettings;
}

export interface ExportPresetMismatch {
  readonly storedPresetId: ExportPresetId;
  readonly selectedPresetId: ExportPresetId;
  readonly canvas: CanvasSize;
}

export interface ExportPresetResolution {
  readonly presetId: ExportPresetId;
  readonly canvas: CanvasSize;
  readonly mismatch: ExportPresetMismatch | undefined;
}

export interface ResolvedExportSettings extends CanvasSize {
  readonly frameRate: number;
  readonly videoBitrate: number;
  readonly audio: ExportAudioSettings;
}

const AUDIO: ExportAudioSettings = Object.freeze({
  codec: 'aac',
  sampleRate: 48_000,
  channels: 2,
  bitrate: 128_000,
});

const DEFAULT_MIN_VIDEO_BITRATE = 2_000_000;
const MAX_VIDEO_BITRATE = 300_000_000;

export const EXPORT_PRESETS: Readonly<Record<ExportPresetId, ExportPresetDefinition>> = {
  'tiktok-1080': {
    id: 'tiktok-1080',
    label: 'TikTok 1080p',
    shape: '9:16',
    size: { width: 1080, height: 1920 },
    frameRate: 30,
    videoBitrate: 62_208_000,
    audio: AUDIO,
  },
  'instagram-feed-4x5': {
    id: 'instagram-feed-4x5',
    label: 'Instagram Feed 4:5',
    shape: '4:5',
    size: { width: 1080, height: 1350 },
    frameRate: 30,
    videoBitrate: 43_740_000,
    audio: AUDIO,
  },
  'square-1080': {
    id: 'square-1080',
    label: 'Square 1:1',
    shape: '1:1',
    size: { width: 1080, height: 1080 },
    frameRate: 30,
    videoBitrate: 34_992_000,
    audio: AUDIO,
  },
  'landscape-4k': {
    id: 'landscape-4k',
    label: 'Landscape 4K',
    shape: '16:9',
    size: { width: 3840, height: 2160 },
    frameRate: 30,
    videoBitrate: 248_832_000,
    audio: AUDIO,
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    shape: 'canvas',
    size: 'canvas',
    frameRate: 30,
    videoBitrate: 'canvas-default',
    audio: AUDIO,
  },
  'social-h264-aac': {
    id: 'social-h264-aac',
    label: 'Social H.264/AAC',
    shape: 'canvas',
    size: 'canvas',
    frameRate: 30,
    videoBitrate: 'canvas-default',
    audio: AUDIO,
  },
  'reels-1080': {
    id: 'reels-1080',
    label: 'Instagram Reels · 1080p',
    shape: '9:16',
    size: { width: 1080, height: 1920 },
    frameRate: 30,
    videoBitrate: 62_208_000,
    audio: AUDIO,
  },
  'shorts-1080': {
    id: 'shorts-1080',
    label: 'YouTube Shorts · 1080p',
    shape: '9:16',
    size: { width: 1080, height: 1920 },
    frameRate: 30,
    videoBitrate: 62_208_000,
    audio: AUDIO,
  },
  'youtube-1080': {
    id: 'youtube-1080',
    label: 'YouTube · 1080p',
    shape: '16:9',
    size: { width: 1920, height: 1080 },
    frameRate: 30,
    videoBitrate: 62_208_000,
    audio: AUDIO,
  },
  'high-bitrate': {
    id: 'high-bitrate',
    label: 'High bitrate',
    shape: 'canvas',
    size: 'canvas',
    frameRate: 30,
    videoBitrate: 'canvas-high',
    audio: AUDIO,
  },
};

/** Fixed match order avoids ambiguous canvas matches for legacy duplicate sizes. */
const CANVAS_MATCH_ORDER: readonly ExportPresetId[] = [
  'tiktok-1080',
  'instagram-feed-4x5',
  'square-1080',
  'landscape-4k',
  'youtube-1080',
  'reels-1080',
  'shorts-1080',
];

export const EXPORT_PRESET_MENU_IDS: readonly ExportPresetId[] = [
  // Grouped by shape so the list reads in order: landscape, vertical, then the rest.
  'youtube-1080',
  'landscape-4k',
  'high-bitrate',
  'reels-1080',
  'shorts-1080',
  'tiktok-1080',
  'instagram-feed-4x5',
  'square-1080',
  'custom',
];

export function isExportPresetId(value: string): value is ExportPresetId {
  return Object.prototype.hasOwnProperty.call(EXPORT_PRESETS, value);
}

export function exportPresetCanvasSize(presetId: ExportPresetId, canvas: CanvasSize): CanvasSize {
  const size = EXPORT_PRESETS[presetId].size;
  return size === 'canvas' ? canvas : size;
}

export function exportPresetForCanvas(
  width: number,
  height: number,
  preferredPresetId?: ExportPresetId,
): ExportPresetId {
  if (preferredPresetId !== undefined) {
    const preferredSize = EXPORT_PRESETS[preferredPresetId].size;
    if (
      preferredSize !== 'canvas' &&
      preferredSize.width === width &&
      preferredSize.height === height
    )
      return preferredPresetId;
  }
  return (
    CANVAS_MATCH_ORDER.find((id) => {
      const size = EXPORT_PRESETS[id].size;
      return size !== 'canvas' && size.width === width && size.height === height;
    }) ?? 'custom'
  );
}

export function reconcileExportPresetOnLoad(
  storedPresetId: ExportPresetId | undefined,
  canvas: CanvasSize,
): ExportPresetResolution {
  if (storedPresetId === undefined) {
    return {
      presetId: exportPresetForCanvas(canvas.width, canvas.height),
      canvas: { ...canvas },
      mismatch: undefined,
    };
  }

  const storedSize = EXPORT_PRESETS[storedPresetId].size;
  const matchesCanvas =
    storedSize === 'canvas' ||
    (storedSize.width === canvas.width && storedSize.height === canvas.height);
  if (matchesCanvas)
    return { presetId: storedPresetId, canvas: { ...canvas }, mismatch: undefined };

  const selectedPresetId = exportPresetForCanvas(canvas.width, canvas.height);
  return {
    presetId: selectedPresetId,
    canvas: { ...canvas },
    mismatch: {
      storedPresetId,
      selectedPresetId,
      canvas: { ...canvas },
    },
  };
}

export function exportPresetMismatchMessage(mismatch: ExportPresetMismatch): string {
  const stored = EXPORT_PRESETS[mismatch.storedPresetId];
  const selected = EXPORT_PRESETS[mismatch.selectedPresetId];
  const storedSize =
    stored.size === 'canvas' ? 'canvas size' : `${stored.size.width}×${stored.size.height}`;
  return `Saved preset ${stored.label} (${storedSize}) did not match canvas ${mismatch.canvas.width}×${mismatch.canvas.height}. Kept the canvas and selected ${selected.label}.`;
}

export function resolveExportSettings(
  presetId: ExportPresetId,
  canvas: CanvasSize,
): ResolvedExportSettings {
  const preset = EXPORT_PRESETS[presetId];
  const rawBitrate =
    typeof preset.videoBitrate === 'number'
      ? preset.videoBitrate
      : preset.videoBitrate === 'canvas-high'
        ? Math.max(canvas.width, 1920) * Math.max(canvas.height, 1080) * preset.frameRate
        : canvas.width * canvas.height * preset.frameRate;
  const videoBitrate = Math.round(
    Math.min(Math.max(rawBitrate, DEFAULT_MIN_VIDEO_BITRATE), MAX_VIDEO_BITRATE),
  );
  return {
    width: canvas.width,
    height: canvas.height,
    frameRate: preset.frameRate,
    videoBitrate,
    audio: { ...preset.audio },
  };
}
