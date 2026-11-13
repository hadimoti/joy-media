import type { AssetRecordV1, JoyProjectV1 } from '@joy-media/project-schema';
import type { AnimationDescriptorV1 } from '@joy-media/project-schema';
import { bindClipToObject, writeClipMediaKind } from './sticker-bindings.js';

export interface ImportedMediaAsset {
  readonly id: string;
  readonly kind: 'video' | 'audio' | 'image';
  readonly displayName: string;
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

export function projectWithImportedAsset(
  project: JoyProjectV1,
  asset: ImportedMediaAsset,
): JoyProjectV1 {
  return {
    ...project,
    assets: {
      ...project.assets,
      [asset.id]: {
        ...project.assets[asset.id],
        id: asset.id,
        kind: asset.kind,
        displayName: asset.displayName,
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

/** Adds or updates the persistent clip controller binding for a placed asset. */
export function bindMediaClipToProject(
  project: JoyProjectV1,
  asset: ImportedMediaAsset,
  clipId: string,
): JoyProjectV1 {
  const importedProject = projectWithImportedAsset(project, asset);
  const controllerId = `media-controller-${clipId}`;
  const existingController = importedProject.visualObjects[controllerId];
  if (existingController !== undefined) {
    return writeClipMediaKind(
      {
        ...importedProject,
        visualObjects: {
          ...importedProject.visualObjects,
          [controllerId]: { ...existingController, assetId: asset.id },
        },
      },
      clipId,
      asset.kind,
    );
  }

  return writeClipMediaKind(
    bindClipToObject(
      {
        ...importedProject,
        visualObjects: {
          ...importedProject.visualObjects,
          [controllerId]: {
            id: controllerId,
            kind: 'null',
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
        },
      },
      clipId,
      controllerId,
    ),
    clipId,
    asset.kind,
  );
}
