import type {
  UpscaleJobPayload,
  UpscaleMemoryMode,
  UpscalePreset,
  UpscaleScale,
} from '@joy-media/job-protocol';
import type { JoyProjectV1, JsonValue } from '@joy-media/project-schema';

export const UPSCALING_PLUGIN_KEY = 'joy.upscaling';

export interface UpscaleTarget {
  readonly targetId: string;
  readonly assetId: string;
  readonly kind: 'image' | 'video';
  readonly objectId?: string;
  readonly clipId?: string;
  readonly durationUs?: number;
  readonly playheadUs?: number;
}

export interface UpscaleJobState {
  readonly id: string;
  readonly state: 'queued' | 'leased' | 'completed' | 'failed' | 'canceled';
  readonly progress: number;
  readonly error?: string;
  readonly resultAssetId?: string;
}

export interface UpscaleSettings {
  readonly schemaVersion: 1;
  readonly preset: UpscalePreset;
  readonly scale: UpscaleScale;
  readonly imageFormat: 'png' | 'jpeg';
  readonly memoryMode: UpscaleMemoryMode;
  readonly restorationStrength: number;
  readonly denoiseStrength: number;
  readonly keepAudio: boolean;
  readonly lastJob?: UpscaleJobState;
}

export function defaultUpscaleSettings(): UpscaleSettings {
  return {
    schemaVersion: 1,
    preset: 'quality',
    scale: 2,
    imageFormat: 'png',
    memoryMode: 'auto',
    restorationStrength: 0.75,
    denoiseStrength: 0.25,
    keepAudio: true,
  };
}

export function readUpscaleSettings(
  project: Pick<JoyProjectV1, 'pluginData'>,
  targetId: string,
): UpscaleSettings {
  const defaults = defaultUpscaleSettings();
  const root = record(project.pluginData[UPSCALING_PLUGIN_KEY]);
  const raw = record(root?.[targetId]);
  if (raw === undefined) return defaults;
  const lastJob = record(raw.lastJob);
  const state = oneOf(lastJob?.state, ['queued', 'leased', 'completed', 'failed', 'canceled'])
    ? (lastJob!.state as UpscaleJobState['state'])
    : undefined;
  return {
    schemaVersion: 1,
    preset: oneOf(raw.preset, ['fast', 'quality'])
      ? (raw.preset as UpscalePreset)
      : defaults.preset,
    scale: raw.scale === 4 ? 4 : 2,
    imageFormat: raw.imageFormat === 'jpeg' ? 'jpeg' : 'png',
    memoryMode: oneOf(raw.memoryMode, ['auto', 'low-vram', 'maximum-quality'])
      ? (raw.memoryMode as UpscaleMemoryMode)
      : defaults.memoryMode,
    restorationStrength: clampNumber(raw.restorationStrength, 0, 1, defaults.restorationStrength),
    denoiseStrength: clampNumber(raw.denoiseStrength, 0, 1, defaults.denoiseStrength),
    keepAudio: typeof raw.keepAudio === 'boolean' ? raw.keepAudio : defaults.keepAudio,
    ...(lastJob !== undefined && typeof lastJob.id === 'string' && state !== undefined
      ? {
          lastJob: {
            id: lastJob.id,
            state,
            progress: clampNumber(lastJob.progress, 0, 100, 0),
            ...(typeof lastJob.error === 'string' ? { error: lastJob.error.slice(0, 500) } : {}),
            ...(typeof lastJob.resultAssetId === 'string'
              ? { resultAssetId: lastJob.resultAssetId }
              : {}),
          },
        }
      : {}),
  };
}

export function writeUpscaleSettings(
  project: JoyProjectV1,
  targetId: string,
  settings: UpscaleSettings,
): JoyProjectV1 {
  const root = record(project.pluginData[UPSCALING_PLUGIN_KEY]) ?? {};
  return {
    ...project,
    pluginData: {
      ...project.pluginData,
      [UPSCALING_PLUGIN_KEY]: { ...root, [targetId]: settings } as unknown as JsonValue,
    },
    updatedAt: new Date().toISOString(),
  };
}

export function upscaleJobPayload(
  settings: UpscaleSettings,
  target: Pick<UpscaleTarget, 'kind' | 'durationUs' | 'playheadUs'>,
  purpose: 'preview' | 'full' = 'full',
): UpscaleJobPayload {
  const endUs = target.durationUs === undefined ? undefined : Math.max(1, target.durationUs);
  const startUs = target.kind === 'video' ? Math.max(0, Math.round(target.playheadUs ?? 0)) : 0;
  return {
    schemaVersion: 1,
    mediaKind: target.kind,
    preset: settings.preset,
    output: {
      mode: 'scale',
      scale: settings.scale,
      ...(target.kind === 'image'
        ? { imageFormat: settings.imageFormat }
        : { videoProfile: 'h264-aac-mp4' }),
    },
    processing: {
      memoryMode: settings.memoryMode,
      restorationStrength: settings.restorationStrength,
      denoiseStrength: settings.denoiseStrength,
      ...(target.kind === 'video' ? { keepAudio: settings.keepAudio } : {}),
    },
    ...(target.kind === 'video' && endUs !== undefined
      ? { range: { startUs: Math.min(startUs, endUs - 1), endUs, purpose } }
      : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function oneOf(value: unknown, values: readonly string[]): value is string {
  return typeof value === 'string' && values.includes(value);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}
