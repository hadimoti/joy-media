import type {
  Clip,
  JoyProjectV1,
  JsonValue,
  SpikeProject,
  VisualObjectV1,
} from '@joy-media/project-schema';
import { readClipObjectMap } from './sticker-bindings.js';

/**
 * Presentation taxonomy for authored timeline elements.
 *
 * The spike timeline still stores every placed item as a video-shaped clip.
 * This durable map preserves the editor meaning without teaching render-facing
 * project schema that an effect controller is fake media.
 */
export const TIMELINE_ELEMENT_KIND_PLUGIN_KEY = 'joy.timelineElementKinds';
export const EFFECT_LAYER_TARGET_PLUGIN_KEY = 'joy.effectLayerTargets';

export const TIMELINE_ELEMENT_KINDS = [
  'video',
  'text',
  'caption',
  'motion',
  'effect',
  'filter',
  'adjust',
  'overlay',
  'scene3d',
  'audio',
] as const;

export type TimelineElementKind = (typeof TIMELINE_ELEMENT_KINDS)[number];
export type TimelineElementKindMap = Readonly<Record<string, TimelineElementKind>>;
export type EffectLayerTargetMap = Readonly<Record<string, string>>;

const AUDIO_TOKEN = /(?:^|[^a-z0-9])(voice|audio|vo|sfx|music|aiff|wav|mp3|m4a)(?:$|[^a-z0-9])/i;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isTimelineElementKind(value: unknown): value is TimelineElementKind {
  return typeof value === 'string' && (TIMELINE_ELEMENT_KINDS as readonly string[]).includes(value);
}

export function readTimelineElementKindMap(
  project: Pick<JoyProjectV1, 'pluginData'>,
): TimelineElementKindMap {
  const raw = project.pluginData[TIMELINE_ELEMENT_KIND_PLUGIN_KEY];
  if (!isRecord(raw)) return {};
  const result: Record<string, TimelineElementKind> = {};
  for (const [clipId, kind] of Object.entries(raw)) {
    if (isTimelineElementKind(kind)) result[clipId] = kind;
  }
  return result;
}

export function writeTimelineElementKindMap(
  project: JoyProjectV1,
  kinds: TimelineElementKindMap,
): JoyProjectV1 {
  return {
    ...project,
    updatedAt: new Date().toISOString(),
    pluginData: {
      ...project.pluginData,
      [TIMELINE_ELEMENT_KIND_PLUGIN_KEY]: { ...kinds } as unknown as JsonValue,
    },
  };
}

export function withTimelineElementKinds(
  project: JoyProjectV1,
  kinds: TimelineElementKindMap,
): JoyProjectV1 {
  return writeTimelineElementKindMap(project, {
    ...readTimelineElementKindMap(project),
    ...kinds,
  });
}

export function timelineElementKindForClip(
  clip: Clip,
  kinds: TimelineElementKindMap = {},
): TimelineElementKind {
  const explicit = kinds[clip.id];
  if (explicit !== undefined) return explicit;
  if (clip.kind === 'video' && AUDIO_TOKEN.test(`${clip.id}\0${clip.assetId}`)) return 'audio';
  return 'video';
}

export function isControlTimelineElement(kind: TimelineElementKind): boolean {
  return (
    kind === 'text' ||
    kind === 'caption' ||
    kind === 'motion' ||
    kind === 'effect' ||
    kind === 'filter' ||
    kind === 'adjust'
  );
}

export function isAdjustmentTargetKind(kind: TimelineElementKind): boolean {
  return kind === 'video' || kind === 'overlay' || kind === 'scene3d';
}

export function readEffectLayerTargetMap(
  project: Pick<JoyProjectV1, 'pluginData'>,
): EffectLayerTargetMap {
  const raw = project.pluginData[EFFECT_LAYER_TARGET_PLUGIN_KEY];
  if (!isRecord(raw)) return {};
  const result: Record<string, string> = {};
  for (const [objectId, targetClipId] of Object.entries(raw)) {
    if (typeof targetClipId === 'string' && targetClipId.length > 0) {
      result[objectId] = targetClipId;
    }
  }
  return result;
}

export function withEffectLayerTarget(
  project: JoyProjectV1,
  objectId: string,
  targetClipId: string | undefined,
): JoyProjectV1 {
  const targets: Record<string, string> = { ...readEffectLayerTargetMap(project) };
  if (targetClipId === undefined || targetClipId.length === 0) delete targets[objectId];
  else targets[objectId] = targetClipId;
  return {
    ...project,
    updatedAt: new Date().toISOString(),
    pluginData: {
      ...project.pluginData,
      [EFFECT_LAYER_TARGET_PLUGIN_KEY]: targets as unknown as JsonValue,
    },
  };
}

export function timelineClipsForObject(
  project: JoyProjectV1,
  timeline: SpikeProject,
  objectId: string,
): readonly Clip[] {
  const clipObjects = readClipObjectMap(project);
  const clipIds = new Set(
    Object.entries(clipObjects)
      .filter(([, candidate]) => candidate === objectId)
      .map(([clipId]) => clipId),
  );
  if (clipIds.size === 0) return [];
  return Object.values(timeline.compositions)
    .flatMap((composition) => composition.tracks)
    .flatMap((track) => track.clips)
    .filter((clip) => clipIds.has(clip.id));
}

/** Effect/filter/adjust controller objects targeting a clip and active now. */
export function activeEffectLayerObjects(
  project: JoyProjectV1,
  timeline: SpikeProject,
  targetClipId: string,
  timeUs: number,
): readonly VisualObjectV1[] {
  const targets = readEffectLayerTargetMap(project);
  return Object.entries(targets).flatMap(([objectId, target]) => {
    if (target !== targetClipId) return [];
    const object = project.visualObjects[objectId];
    const active = timelineClipsForObject(project, timeline, objectId).some(
      (clip) => timeUs >= clip.startUs && timeUs < clip.startUs + clip.durationUs,
    );
    if (object === undefined || !active) {
      return [];
    }
    return [object];
  });
}
