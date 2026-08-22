import type { JoyProjectV1 } from '@joy-media/project-schema';
import type { PlannedCaptureRequirement } from '@joy-media/render-planner';
import type { CropInsets } from './sticker-image-cache.js';
import { readImageMatteMap } from './sticker-bindings.js';

export interface PlannedStillBitmapTarget {
  readonly requirementId: string;
  readonly objectId: string;
  readonly assetId: string;
  readonly matteAssetId?: string;
  readonly crop: CropInsets;
}

export interface PlannedHtmlSceneCaptureTarget {
  readonly requirementId: string;
  readonly objectId: string;
  readonly assetId: string;
  readonly scenePackageId: string;
  readonly timeUs: number;
}

export interface PlannedMotionSceneCaptureTarget {
  readonly requirementId: string;
  readonly objectId: string;
  readonly assetId: string;
  readonly motionSceneId: string;
  readonly timeUs: number;
}

export function plannedStillBitmapTargets(
  project: JoyProjectV1,
  requirements: readonly PlannedCaptureRequirement[],
): readonly PlannedStillBitmapTarget[] {
  const mattes = readImageMatteMap(project);
  return requirements.flatMap((requirement): readonly PlannedStillBitmapTarget[] => {
    if (
      requirement.kind !== 'still-bitmap' ||
      requirement.objectId === undefined ||
      requirement.assetId === undefined
    ) {
      return [];
    }
    const object = project.visualObjects[requirement.objectId];
    if (object?.kind !== 'image') return [];
    return [
      {
        requirementId: requirement.id,
        objectId: requirement.objectId,
        assetId: requirement.assetId,
        ...(mattes[requirement.objectId] !== undefined
          ? { matteAssetId: mattes[requirement.objectId] }
          : {}),
        crop: object.transform.crop,
      },
    ];
  });
}

export function plannedHtmlSceneCaptureTargets(
  project: JoyProjectV1,
  requirements: readonly PlannedCaptureRequirement[],
): readonly PlannedHtmlSceneCaptureTarget[] {
  return requirements.flatMap((requirement): readonly PlannedHtmlSceneCaptureTarget[] => {
    if (
      requirement.kind !== 'html-scene' ||
      requirement.objectId === undefined ||
      requirement.assetId === undefined ||
      requirement.sourceTimeUs === undefined
    ) {
      return [];
    }
    const object = project.visualObjects[requirement.objectId];
    if (object?.kind !== 'html-scene') return [];
    const scenePackageId = parseHtmlScenePackageId(requirement.assetId);
    if (scenePackageId === undefined) return [];
    return [
      {
        requirementId: requirement.id,
        objectId: requirement.objectId,
        assetId: requirement.assetId,
        scenePackageId,
        timeUs: requirement.sourceTimeUs,
      },
    ];
  });
}

export const htmlSceneCaptureTargetsForRequirements = plannedHtmlSceneCaptureTargets;

export function plannedMotionSceneCaptureTargets(
  project: JoyProjectV1,
  requirements: readonly PlannedCaptureRequirement[],
): readonly PlannedMotionSceneCaptureTarget[] {
  return requirements.flatMap((requirement): readonly PlannedMotionSceneCaptureTarget[] => {
    if (
      requirement.kind !== 'motion-scene' ||
      requirement.objectId === undefined ||
      requirement.assetId === undefined ||
      requirement.sourceTimeUs === undefined
    ) {
      return [];
    }
    const object = project.visualObjects[requirement.objectId];
    if (object?.kind !== 'motion-scene' || object.motionSceneId === undefined) return [];
    const motionSceneId = parseMotionSceneId(requirement.assetId);
    if (motionSceneId === undefined || motionSceneId !== object.motionSceneId) return [];
    return [
      {
        requirementId: requirement.id,
        objectId: requirement.objectId,
        assetId: requirement.assetId,
        motionSceneId,
        timeUs: requirement.sourceTimeUs,
      },
    ];
  });
}

export function requiredCaptureObjectIds(
  requirements: readonly PlannedCaptureRequirement[],
  kind: 'still-bitmap' | 'html-scene',
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const requirement of requirements) {
    if (requirement.kind !== kind || requirement.objectId === undefined) continue;
    ids.add(requirement.objectId);
  }
  return ids;
}

function parseHtmlScenePackageId(assetId: string): string | undefined {
  const prefix = 'html-scene:';
  return assetId.startsWith(prefix) ? assetId.slice(prefix.length) : undefined;
}

function parseMotionSceneId(assetId: string): string | undefined {
  const prefix = 'motion-scene:';
  return assetId.startsWith(prefix) ? assetId.slice(prefix.length) : undefined;
}
