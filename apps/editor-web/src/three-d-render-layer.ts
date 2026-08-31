import type {
  JoyProjectV1,
  SpikeProject,
  VisualObjectV1,
  JsonValue,
} from '@joy-media/project-schema';
import type { CommandTransaction } from '@joy-media/commands';
import { bindClipToObject } from './sticker-bindings.js';
import { withTimelineElementKinds } from './timeline-element-kind.js';
import { upsertUniversalTimelineBinding } from './universal-placement.js';

export const THREE_D_PLUGIN_KEY = 'joy.3d.v1';

function pluginRecord(value: unknown): Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

export interface ThreeDSceneStateV1 {
  readonly version: 1;
  readonly sceneId: string;
  readonly sourceRefs: readonly string[];
  readonly camera: {
    readonly position: readonly [number, number, number];
    readonly target: readonly [number, number, number];
  };
  readonly model: {
    readonly position: readonly [number, number, number];
    readonly rotation: readonly [number, number, number];
    readonly scale: readonly [number, number, number];
  };
  readonly light: { readonly intensity: number; readonly color: string };
  readonly material: { readonly colors: readonly string[] };
}

export function readThreeDSceneState(
  project: Pick<JoyProjectV1, 'pluginData'>,
  sceneId: string,
): ThreeDSceneStateV1 | undefined {
  const value = pluginRecord(project.pluginData[THREE_D_PLUGIN_KEY])[sceneId];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return isThreeDSceneState(value, sceneId) ? (value as unknown as ThreeDSceneStateV1) : undefined;
}

export function readThreeDSceneStates(
  project: Pick<JoyProjectV1, 'pluginData'>,
): readonly ThreeDSceneStateV1[] {
  return Object.values(pluginRecord(project.pluginData[THREE_D_PLUGIN_KEY]))
    .filter((value): value is JsonValue => isThreeDSceneState(value))
    .map((value) => value as unknown as ThreeDSceneStateV1);
}

function isTuple3(value: unknown): value is readonly [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

function isThreeDSceneState(value: JsonValue, sceneId?: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ThreeDSceneStateV1>;
  return (
    candidate.version === 1 &&
    typeof candidate.sceneId === 'string' &&
    (sceneId === undefined || candidate.sceneId === sceneId) &&
    Array.isArray(candidate.sourceRefs) &&
    candidate.sourceRefs.every((ref) => typeof ref === 'string') &&
    typeof candidate.camera === 'object' &&
    candidate.camera !== null &&
    isTuple3(candidate.camera.position) &&
    isTuple3(candidate.camera.target) &&
    typeof candidate.model === 'object' &&
    candidate.model !== null &&
    isTuple3(candidate.model.position) &&
    isTuple3(candidate.model.rotation) &&
    isTuple3(candidate.model.scale) &&
    typeof candidate.light === 'object' &&
    candidate.light !== null &&
    typeof candidate.light.intensity === 'number' &&
    Number.isFinite(candidate.light.intensity) &&
    typeof candidate.light.color === 'string' &&
    typeof candidate.material === 'object' &&
    candidate.material !== null &&
    Array.isArray(candidate.material.colors) &&
    candidate.material.colors.every((color) => typeof color === 'string')
  );
}

export interface ThreeDRenderLayerInsertion {
  readonly label: string;
  readonly clipId: string;
  readonly objectId: string;
  readonly timeline: CommandTransaction;
  readonly project: JoyProjectV1;
}

/** Build one undoable image-backed 3D render layer at the current playhead. */
export function buildThreeDRenderLayerInsertion({
  timeline,
  project,
  playheadUs,
  token,
  asset,
}: {
  readonly timeline: SpikeProject;
  readonly project: JoyProjectV1;
  readonly playheadUs: number;
  readonly token: string;
  readonly asset: {
    readonly assetId: string;
    readonly displayName: string;
    readonly bytes: number;
    readonly mimeType: string;
    readonly sha256?: string;
    readonly scene?: ThreeDSceneStateV1;
  };
}): ThreeDRenderLayerInsertion {
  const composition = timeline.compositions[timeline.rootCompositionId];
  if (composition === undefined || composition.durationUs <= 0) {
    throw new Error('The main timeline is unavailable.');
  }

  const objectId = `scene3d-${token}`;
  const clipId = `clip-${objectId}`;
  const trackId = `3D-${token}`;
  const order = composition.tracks.reduce((max, track) => Math.max(max, track.order), -1) + 1;
  const startUs = Math.min(Math.max(0, playheadUs), Math.max(0, composition.durationUs - 1));
  const durationUs = Math.min(5_000_000, composition.durationUs - startUs);
  const sceneCount = Object.values(project.visualObjects).filter(
    (object) => object.kind === 'image' && object.id.startsWith('scene3d-'),
  ).length;
  const nextObject: VisualObjectV1 = {
    id: objectId,
    kind: 'image',
    assetId: asset.assetId,
    transform: {
      x: 120 + sceneCount * 32,
      y: 120 + sceneCount * 32,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    },
  };
  const sceneId = asset.scene?.sceneId ?? `scene-${token}`;
  const withAssetAndObject: JoyProjectV1 = {
    ...project,
    updatedAt: new Date().toISOString(),
    assets: {
      ...project.assets,
      [asset.assetId]: {
        id: asset.assetId,
        kind: 'image',
        displayName: asset.displayName,
        ...(asset.sha256 === undefined ? {} : { sha256: asset.sha256 }),
        bytes: asset.bytes,
        descriptor: { mimeType: asset.mimeType },
      },
    },
    visualObjects: { ...project.visualObjects, [objectId]: nextObject },
    pluginData: {
      ...project.pluginData,
      [THREE_D_PLUGIN_KEY]: {
        ...pluginRecord(project.pluginData[THREE_D_PLUGIN_KEY]),
        [sceneId]: asset.scene ?? {
          version: 1,
          sceneId,
          sourceRefs: [asset.displayName],
          camera: { position: [0, 0, 6], target: [0, 0, 0] },
          model: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          light: { intensity: 1, color: '#ffffff' },
          material: { colors: [] },
        },
      } as JsonValue,
    },
  };
  const nextProject = upsertUniversalTimelineBinding(
    withTimelineElementKinds(bindClipToObject(withAssetAndObject, clipId, objectId), {
      [clipId]: 'scene3d',
    }),
    {
      id: clipId,
      compositionId: composition.id,
      trackId,
      elementKind: 'image',
      startUs,
      durationUs,
      source: { kind: 'object', id: objectId },
    },
  );
  const label = `Add 3D render ${asset.displayName}`;

  return {
    label,
    clipId,
    objectId,
    timeline: {
      label,
      commands: [
        {
          type: 'timeline.addTrack',
          payload: {
            compositionId: composition.id,
            track: {
              id: trackId,
              kind: 'video',
              family: 'visual',
              name: '3D Scene',
              order,
              enabled: true,
              clips: [],
            },
          },
        },
        {
          type: 'timeline.insertClip',
          payload: {
            compositionId: composition.id,
            trackId,
            clip: {
              id: clipId,
              kind: 'video',
              assetId: asset.assetId,
              startUs,
              durationUs,
              sourceInUs: 0,
            },
          },
        },
      ],
    },
    project: nextProject,
  };
}
