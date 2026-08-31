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
  const raw = storage.getItem(creativeBriefStorageKey(projectId));
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
  storage.setItem(creativeBriefStorageKey(projectId), JSON.stringify(brief));
}

export function removeCreativeBrief(storage: CreativeBriefStorage, projectId: string): void {
  storage.removeItem?.(creativeBriefStorageKey(projectId));
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
