import type { CreativeBriefV1 } from '@joy-media/agent-tools';

export interface CreativeBriefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export const CREATIVE_BRIEF_STORAGE_PREFIX = 'joy-media.creative-brief.v1:';

export function creativeBriefStorageKey(projectId: string): string {
  return `${CREATIVE_BRIEF_STORAGE_PREFIX}${projectId}`;
}

export function loadCreativeBrief(
  storage: CreativeBriefStorage,
  projectId: string,
): CreativeBriefV1 | undefined {
  let raw: string | null;
  try {
    raw = storage.getItem(creativeBriefStorageKey(projectId));
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isBrief(value)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function saveCreativeBrief(
  storage: CreativeBriefStorage,
  projectId: string,
  brief: CreativeBriefV1,
): void {
  try {
    storage.setItem(creativeBriefStorageKey(projectId), JSON.stringify(brief));
  } catch {
    // Storage is an optional cache; callers retain the in-memory brief.
  }
}

export function removeCreativeBrief(storage: CreativeBriefStorage, projectId: string): void {
  try {
    storage.removeItem?.(creativeBriefStorageKey(projectId));
  } catch {
    // Storage is an optional cache; clearing the in-memory state still works.
  }
}

function isBrief(value: unknown): value is CreativeBriefV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
    typeof (value as { snapshotRevisionId?: unknown }).snapshotRevisionId === 'string' &&
    typeof (value as { projectId?: unknown }).projectId === 'string' &&
    typeof (value as { request?: unknown }).request === 'string'
  );
}
