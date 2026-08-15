import type { MaskJobPayload, MaskProvider, MaskSelectionMode } from '@joy-media/job-protocol';
import type { JoyProjectV1, JsonValue } from '@joy-media/project-schema';

export const MASKING_PLUGIN_KEY = 'joy.masking';
export const VIDEO_MASK_SOURCE_PLUGIN_KEY = 'joy.videoMaskSource';

export interface MaskTarget {
  readonly targetId: string;
  readonly assetId: string;
  readonly kind: 'image' | 'video';
  readonly objectId?: string;
  readonly clipId?: string;
  readonly durationUs?: number;
  readonly playheadUs?: number;
}

export interface MaskJobState {
  readonly id: string;
  readonly state: 'queued' | 'leased' | 'completed' | 'failed' | 'canceled';
  readonly progress: number;
  readonly error?: string;
  readonly resultAssetId?: string;
}

export interface MaskSettings extends MaskJobPayload {
  readonly lastJob?: MaskJobState;
}

export function defaultMaskSettings(kind: MaskTarget['kind']): MaskSettings {
  return {
    schemaVersion: 1,
    provider: 'auto',
    selection: { mode: 'subject' },
    edge: { featherPx: 2, expansionPx: 0, detail: 0.75, decontaminate: true },
    invert: false,
    output: kind === 'video' ? 'cutout' : 'matte',
    ...(kind === 'video'
      ? {
          video: {
            range: 'clip',
            direction: 'both',
            temporalConsistency: 0.85,
          },
        }
      : {}),
  };
}

export function readMaskSettings(
  project: Pick<JoyProjectV1, 'pluginData'>,
  targetId: string,
  kind: MaskTarget['kind'],
): MaskSettings {
  const defaults = defaultMaskSettings(kind);
  const root = record(project.pluginData[MASKING_PLUGIN_KEY]);
  const raw = record(root?.[targetId]);
  if (raw === undefined) return defaults;
  const selection = record(raw.selection);
  const edge = record(raw.edge);
  const video = record(raw.video);
  const lastJob = record(raw.lastJob);
  const provider = oneOf(raw.provider, ['auto', 'sam3', 'sam2-grounded', 'birefnet'])
    ? (raw.provider as MaskProvider)
    : defaults.provider;
  const mode = oneOf(selection?.mode, ['subject', 'person', 'prompt', 'points', 'box'])
    ? (selection!.mode as MaskSelectionMode)
    : defaults.selection.mode;
  const points = Array.isArray(selection?.points)
    ? selection!.points.flatMap((value) => {
        const point = record(value);
        if (
          point === undefined ||
          !number(point.x) ||
          !number(point.y) ||
          !oneOf(point.label, ['foreground', 'background'])
        )
          return [];
        return [
          {
            x: clamp(point.x as number, 0, 1),
            y: clamp(point.y as number, 0, 1),
            label: point.label as 'foreground' | 'background',
            ...(number(point.timeUs)
              ? { timeUs: Math.max(0, Math.round(point.timeUs as number)) }
              : {}),
          },
        ];
      })
    : undefined;
  const box = record(selection?.box);
  const parsedBox =
    box !== undefined && number(box.x) && number(box.y) && number(box.width) && number(box.height)
      ? {
          x: clamp(box.x as number, 0, 1),
          y: clamp(box.y as number, 0, 1),
          width: clamp(box.width as number, 0.001, 1),
          height: clamp(box.height as number, 0.001, 1),
          ...(number(box.timeUs) ? { timeUs: Math.max(0, Math.round(box.timeUs as number)) } : {}),
        }
      : undefined;
  const lastState = oneOf(lastJob?.state, ['queued', 'leased', 'completed', 'failed', 'canceled'])
    ? (lastJob!.state as MaskJobState['state'])
    : undefined;
  return {
    schemaVersion: 1,
    provider,
    selection: {
      mode,
      ...(number(selection?.timeUs)
        ? { timeUs: Math.max(0, Math.round(selection.timeUs as number)) }
        : {}),
      ...(typeof selection?.prompt === 'string' && selection.prompt.trim().length > 0
        ? { prompt: selection.prompt.trim().slice(0, 500) }
        : {}),
      ...(points === undefined || points.length === 0 ? {} : { points: points.slice(0, 64) }),
      ...(parsedBox === undefined ? {} : { box: parsedBox }),
    },
    edge: {
      featherPx: number(edge?.featherPx)
        ? clamp(edge!.featherPx as number, 0, 100)
        : defaults.edge.featherPx,
      expansionPx: number(edge?.expansionPx)
        ? clamp(edge!.expansionPx as number, -100, 100)
        : defaults.edge.expansionPx,
      detail: number(edge?.detail) ? clamp(edge!.detail as number, 0, 1) : defaults.edge.detail,
      decontaminate:
        typeof edge?.decontaminate === 'boolean' ? edge.decontaminate : defaults.edge.decontaminate,
    },
    invert: typeof raw.invert === 'boolean' ? raw.invert : defaults.invert,
    output: oneOf(raw.output, ['matte', 'cutout'])
      ? (raw.output as 'matte' | 'cutout')
      : defaults.output,
    ...(kind === 'video'
      ? {
          video: {
            range: video?.range === 'in-out' ? 'in-out' : 'clip',
            ...(number(video?.inUs)
              ? { inUs: Math.max(0, Math.round(video!.inUs as number)) }
              : {}),
            ...(number(video?.outUs)
              ? { outUs: Math.max(0, Math.round(video!.outUs as number)) }
              : {}),
            direction: oneOf(video?.direction, ['forward', 'backward', 'both'])
              ? (video!.direction as 'forward' | 'backward' | 'both')
              : 'both',
            temporalConsistency: number(video?.temporalConsistency)
              ? clamp(video!.temporalConsistency as number, 0, 1)
              : 0.85,
          },
        }
      : {}),
    ...(lastJob !== undefined && typeof lastJob.id === 'string' && lastState !== undefined
      ? {
          lastJob: {
            id: lastJob.id,
            state: lastState,
            progress: number(lastJob.progress) ? clamp(lastJob.progress as number, 0, 100) : 0,
            ...(typeof lastJob.error === 'string' ? { error: lastJob.error.slice(0, 500) } : {}),
            ...(typeof lastJob.resultAssetId === 'string'
              ? { resultAssetId: lastJob.resultAssetId }
              : {}),
          },
        }
      : {}),
  };
}

export function writeMaskSettings(
  project: JoyProjectV1,
  targetId: string,
  settings: MaskSettings,
): JoyProjectV1 {
  const root = record(project.pluginData[MASKING_PLUGIN_KEY]) ?? {};
  return {
    ...project,
    pluginData: {
      ...project.pluginData,
      [MASKING_PLUGIN_KEY]: { ...root, [targetId]: settings } as unknown as JsonValue,
    },
    updatedAt: new Date().toISOString(),
  };
}

export function readVideoMaskSourceMap(
  project: Pick<JoyProjectV1, 'pluginData'>,
): Readonly<Record<string, string>> {
  const raw = record(project.pluginData[VIDEO_MASK_SOURCE_PLUGIN_KEY]);
  if (raw === undefined) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, string] =>
        entry[0].length > 0 && typeof entry[1] === 'string' && entry[1].length > 0,
    ),
  );
}

export function writeVideoMaskSource(
  project: JoyProjectV1,
  clipId: string,
  assetId: string | undefined,
): JoyProjectV1 {
  const next = { ...readVideoMaskSourceMap(project) };
  if (assetId === undefined) delete next[clipId];
  else next[clipId] = assetId;
  return {
    ...project,
    pluginData: {
      ...project.pluginData,
      [VIDEO_MASK_SOURCE_PLUGIN_KEY]: next as unknown as JsonValue,
    },
    updatedAt: new Date().toISOString(),
  };
}

export function maskJobPayload(
  settings: MaskSettings,
  output = settings.output,
  playheadUs?: number,
): MaskJobPayload {
  return {
    schemaVersion: 1,
    provider: settings.provider,
    selection: {
      ...settings.selection,
      ...(settings.video === undefined || playheadUs === undefined
        ? {}
        : { timeUs: Math.max(0, Math.round(playheadUs)) }),
    },
    edge: settings.edge,
    invert: settings.invert,
    output,
    ...(settings.video === undefined ? {} : { video: settings.video }),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function number(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function oneOf(value: unknown, choices: readonly string[]): value is string {
  return typeof value === 'string' && choices.includes(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
