/**
 * Durable Spike clip id → VisualObject id map for stickers/overlays.
 * Replaces the seed-only TIMELINE_OBJECT_IDS hardcode for user-created stickers
 * while keeping seed mappings as defaults when pluginData is empty.
 */

import type { JoyProjectV1, JsonValue } from '@joy-media/project-schema';
import { TIMELINE_OBJECT_IDS } from './editor-project.js';

export const CLIP_OBJECTS_PLUGIN_KEY = 'joy.clipObjects';
export const IMAGE_MATTE_PLUGIN_KEY = 'joy.imageMatte';

export type ClipObjectMap = Readonly<Record<string, string>>;
export type ImageMatteMap = Readonly<Record<string, string>>;

export function readClipObjectMap(project: JoyProjectV1): ClipObjectMap {
  const raw = project.pluginData[CLIP_OBJECTS_PLUGIN_KEY];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...seedClipObjectFlat() };
  }
  const fromPlugin: Record<string, string> = {};
  for (const [clipId, objectId] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof objectId === 'string' && objectId.length > 0) fromPlugin[clipId] = objectId;
  }
  return { ...seedClipObjectFlat(), ...fromPlugin };
}

export function writeClipObjectMap(project: JoyProjectV1, map: ClipObjectMap): JoyProjectV1 {
  const withoutSeed: Record<string, string> = {};
  const seed = seedClipObjectFlat();
  for (const [clipId, objectId] of Object.entries(map)) {
    if (seed[clipId] === objectId) continue;
    withoutSeed[clipId] = objectId;
  }
  return {
    ...project,
    pluginData: {
      ...project.pluginData,
      [CLIP_OBJECTS_PLUGIN_KEY]: withoutSeed as unknown as JsonValue,
    },
    updatedAt: new Date().toISOString(),
  };
}

export function bindClipToObject(
  project: JoyProjectV1,
  clipId: string,
  objectId: string,
): JoyProjectV1 {
  return writeClipObjectMap(project, { ...readClipObjectMap(project), [clipId]: objectId });
}

export function resolveObjectIdForSelection(
  project: JoyProjectV1,
  selectedClipIds: readonly string[],
): string | undefined {
  const map = readClipObjectMap(project);
  for (const clipId of selectedClipIds) {
    const objectId = map[clipId];
    if (objectId !== undefined && project.visualObjects[objectId] !== undefined) return objectId;
  }
  return undefined;
}

export function readImageMatteMap(project: JoyProjectV1): ImageMatteMap {
  const raw = project.pluginData[IMAGE_MATTE_PLUGIN_KEY];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [objectId, matteAssetId] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof matteAssetId === 'string' && matteAssetId.length > 0) out[objectId] = matteAssetId;
  }
  return out;
}

export function writeImageMatte(
  project: JoyProjectV1,
  objectId: string,
  matteAssetId: string,
): JoyProjectV1 {
  return {
    ...project,
    pluginData: {
      ...project.pluginData,
      [IMAGE_MATTE_PLUGIN_KEY]: {
        ...readImageMatteMap(project),
        [objectId]: matteAssetId,
      } as unknown as JsonValue,
    },
    updatedAt: new Date().toISOString(),
  };
}

function seedClipObjectFlat(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [clipId, objectIds] of Object.entries(TIMELINE_OBJECT_IDS)) {
    const first = objectIds[0];
    if (first !== undefined) out[clipId] = first;
  }
  return out;
}
