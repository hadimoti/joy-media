import type { BrowserKeyValueStore } from './browser-store.js';

/** Project documents persisted by the editor. Authentication and UI preferences stay local. */
export const EDITOR_PROJECT_STORAGE_KEYS = [
  'joy-media.active-project.v1',
  'joy-media.project-catalog.v1',
  'joy-media.timeline-project-log.v1',
  'joy-media.visual-object-project-log.v1',
  'joy-media.workflow-graph-log.v1',
  'joy-media.creative-artifact-log.v1',
  'joy-media.look-instances-log.v1',
  'joy-media.motion-scene-project-log.v1',
  'joy-media.export-history.v2',
  'joy-media.project-operation-ledger.v1',
  'joy-media.control-plane-project-bindings.v1',
] as const;

/** Project-specific keys whose names include a project identifier. */
export const EDITOR_PROJECT_STORAGE_PREFIXES = [
  'joy-media.audio-graph.v1.',
  'joy-media.creative-brief.v1:',
  'joy-media.joy-agent-run-checkpoint.v1:',
  'joy-media.agent-idempotency.v1:',
] as const;

export const MAX_EDITOR_PROJECT_STORAGE_KEY_LENGTH = 512;
export const MAX_EDITOR_PROJECT_STORAGE_VALUE_BYTES = 16 * 1024 * 1024;

export interface SynchronousEditorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): readonly string[];
}

export interface EditorProjectStorageAdapter extends BrowserKeyValueStore {
  readonly length?: number;
  key?(index: number): string | null;
}

/** The privileged desktop bridge accepts project documents only, never credentials or UI data. */
export function isEditorProjectStorageKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_EDITOR_PROJECT_STORAGE_KEY_LENGTH) return false;
  return (
    (EDITOR_PROJECT_STORAGE_KEYS as readonly string[]).includes(key) ||
    EDITOR_PROJECT_STORAGE_PREFIXES.some(
      (prefix) => key.startsWith(prefix) && key.length > prefix.length,
    )
  );
}

/**
 * Keeps the editor's synchronous storage contract while moving project documents into the
 * desktop profile. Existing browser values remain readable until the next write, which
 * promotes the value to SQLite and removes the browser copy. Browser-only editors are unchanged.
 */
export function createEditorProjectStorageAdapter(
  browserStorage: BrowserKeyValueStore,
  desktopStorage?: SynchronousEditorStorage,
): EditorProjectStorageAdapter {
  if (desktopStorage === undefined) return browserStorage as EditorProjectStorageAdapter;

  const browserEnumeration = browserStorage as BrowserKeyValueStore & {
    readonly length?: number;
    key?(index: number): string | null;
  };
  let cachedDesktopKeys: readonly string[] | undefined;
  const listKeys = (): readonly string[] => {
    const keys = new Set<string>();
    if (browserEnumeration.length !== undefined && browserEnumeration.key !== undefined) {
      for (let index = 0; index < browserEnumeration.length; index += 1) {
        const key = browserEnumeration.key(index);
        if (key !== null) keys.add(key);
      }
    }
    for (const key of (cachedDesktopKeys ??= desktopStorage
      .keys()
      .filter(isEditorProjectStorageKey)))
      keys.add(key);
    return [...keys];
  };

  return {
    getItem(key) {
      if (!isEditorProjectStorageKey(key)) return browserStorage.getItem(key);
      return desktopStorage.getItem(key) ?? browserStorage.getItem(key);
    },
    setItem(key, value) {
      if (!isEditorProjectStorageKey(key)) {
        browserStorage.setItem(key, value);
        return;
      }
      desktopStorage.setItem(key, value);
      cachedDesktopKeys = undefined;
      browserStorage.removeItem?.(key);
    },
    removeItem(key) {
      if (!isEditorProjectStorageKey(key)) {
        browserStorage.removeItem?.(key);
        return;
      }
      desktopStorage.removeItem(key);
      cachedDesktopKeys = undefined;
      browserStorage.removeItem?.(key);
    },
    get length() {
      return listKeys().length;
    },
    key(index) {
      if (!Number.isInteger(index) || index < 0) return null;
      return listKeys()[index] ?? null;
    },
  };
}
