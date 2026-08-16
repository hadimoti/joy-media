import type {
  AnimationDescriptorV1,
  AssetRecordV1,
  Clip,
  JoyProjectV1,
  TimelineElementKind,
  UniversalTimelineSource,
  VisualObjectV1,
} from '@joy-media/project-schema';
import { bindClipToObject } from './sticker-bindings.js';
import { upsertUniversalTimelineBinding } from './universal-placement.js';

export interface MediaPlacementAsset {
  readonly id: string;
  readonly kind: 'video' | 'audio' | 'image';
  readonly displayName?: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly descriptor?: {
    readonly mimeType?: string;
    readonly durationUs?: number;
    readonly width?: number;
    readonly height?: number;
    readonly animation?: AnimationDescriptorV1;
  };
  readonly generationProvenance?: AssetRecordV1['generationProvenance'];
}

export interface PlannedMediaClip {
  readonly compositionId: string;
  readonly trackId: string;
  readonly clip: Clip;
}

export interface MediaPlacementRequest {
  readonly baseProject: JoyProjectV1;
  readonly asset: MediaPlacementAsset;
  readonly clipId: string;
  readonly planned: PlannedMediaClip;
}

export interface TimelineElementPlacementRequest {
  readonly baseProject: JoyProjectV1;
  readonly clipId: string;
  readonly planned: PlannedMediaClip;
  readonly elementKind: TimelineElementKind;
  readonly source: UniversalTimelineSource;
  readonly sourceInUs?: number;
  readonly asset?: MediaPlacementAsset;
  readonly visualObject?: VisualObjectV1;
}

/**
 * Adds an imported media record without deciding where it belongs. This is
 * deliberately pure so callers can include it in the same compound document
 * snapshot as the Timeline transaction.
 */
export function withImportedAsset(project: JoyProjectV1, asset: MediaPlacementAsset): JoyProjectV1 {
  return {
    ...project,
    assets: {
      ...project.assets,
      [asset.id]: {
        ...project.assets[asset.id],
        id: asset.id,
        kind: asset.kind,
        displayName: asset.displayName ?? asset.id,
        ...(asset.sha256 === undefined ? {} : { sha256: asset.sha256 }),
        ...(asset.bytes === undefined ? {} : { bytes: asset.bytes }),
        ...(asset.descriptor === undefined
          ? {}
          : {
              descriptor: {
                mimeType: asset.descriptor.mimeType ?? 'application/octet-stream',
                ...(asset.descriptor.durationUs === undefined
                  ? {}
                  : { durationUs: asset.descriptor.durationUs }),
                ...(asset.descriptor.width === undefined ? {} : { width: asset.descriptor.width }),
                ...(asset.descriptor.height === undefined
                  ? {}
                  : { height: asset.descriptor.height }),
                ...(asset.descriptor.animation === undefined
                  ? {}
                  : { animation: asset.descriptor.animation }),
              },
            }),
        ...(asset.generationProvenance === undefined
          ? {}
          : { generationProvenance: asset.generationProvenance }),
      },
    },
  };
}

/**
 * Plans the visual/document half of a media placement. The Timeline half is
 * supplied by the caller as `planned`; dispatching both together is what makes
 * Add/import/drop one undo step and prevents orphan clips or bindings.
 */
export function buildMediaPlacementDocument(request: MediaPlacementRequest): JoyProjectV1 {
  const { baseProject, asset, clipId, planned } = request;
  const controllerId = `media-controller-${clipId}`;
  const objectKind = asset.kind === 'image' ? ('image' as const) : ('null' as const);
  return buildTimelineElementDocument({
    baseProject,
    clipId,
    planned,
    elementKind: asset.kind === 'image' ? 'image' : asset.kind === 'audio' ? 'audio' : 'video',
    source:
      asset.kind === 'image'
        ? { kind: 'object', id: controllerId }
        : { kind: 'asset', id: asset.id },
    ...(planned.clip.kind === 'video' ? { sourceInUs: planned.clip.sourceInUs } : {}),
    asset,
    visualObject: {
      id: controllerId,
      kind: objectKind,
      assetId: asset.id,
      transform: {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotationDeg: 0,
        opacity: 1,
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
      },
    },
  });
}

/** Shared document planner for media, stickers, text/shape wrappers, and HTML scenes. */
export function buildTimelineElementDocument(
  request: TimelineElementPlacementRequest,
): JoyProjectV1 {
  const { baseProject, clipId, planned, visualObject } = request;
  if (visualObject !== undefined && baseProject.visualObjects[visualObject.id] !== undefined)
    return baseProject;
  const imported =
    request.asset === undefined ? baseProject : withImportedAsset(baseProject, request.asset);
  const withObject =
    visualObject === undefined
      ? imported
      : bindClipToObject(
          {
            ...imported,
            visualObjects: { ...imported.visualObjects, [visualObject.id]: visualObject },
          },
          clipId,
          visualObject.id,
        );
  return upsertUniversalTimelineBinding(withObject, {
    id: clipId,
    compositionId: planned.compositionId,
    trackId: planned.trackId,
    elementKind: request.elementKind,
    startUs: planned.clip.startUs,
    durationUs: planned.clip.durationUs,
    source: request.source,
    ...(request.sourceInUs === undefined ? {} : { sourceInUs: request.sourceInUs }),
  });
}
