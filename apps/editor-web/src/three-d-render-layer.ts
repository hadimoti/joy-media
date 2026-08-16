import type { JoyProjectV1, SpikeProject, VisualObjectV1 } from '@joy-media/project-schema';
import type { CommandTransaction } from '@joy-media/commands';
import { bindClipToObject } from './sticker-bindings.js';
import { withTimelineElementKinds } from './timeline-element-kind.js';
import { upsertUniversalTimelineBinding } from './universal-placement.js';

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
  const withAssetAndObject: JoyProjectV1 = {
    ...project,
    updatedAt: new Date().toISOString(),
    assets: {
      ...project.assets,
      [asset.assetId]: {
        id: asset.assetId,
        kind: 'image',
        displayName: asset.displayName,
        bytes: asset.bytes,
        descriptor: { mimeType: asset.mimeType },
      },
    },
    visualObjects: { ...project.visualObjects, [objectId]: nextObject },
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
