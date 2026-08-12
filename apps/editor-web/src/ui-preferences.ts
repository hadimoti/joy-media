import type { EditorViewMode } from './dock-layout.js';
import type { WorkspacePresetId } from './panel-metadata.js';

export const EDITOR_UI_PREFERENCES_KEY = 'joy-media.editor-ui-preferences.v2';

export interface EditorUiPreferencesV2 {
  readonly version: 2;
  readonly workspacePreset: WorkspacePresetId;
  readonly viewMode: EditorViewMode;
  readonly projectLibrary: {
    readonly view: 'grid' | 'list';
    readonly sort: 'updated-desc' | 'created-desc' | 'name-asc' | 'name-desc';
  };
  readonly assetLibrary: {
    readonly source: 'user' | 'cloud';
    readonly category: 'all' | 'video' | 'audio' | 'image';
    readonly view: 'large' | 'medium' | 'list';
    readonly sort: string;
    readonly collectionByCategory: Readonly<Record<string, string>>;
  };
  readonly audioStudio: {
    readonly workflowId?: string;
    readonly target?: 'browser' | 'worker' | 'cloud';
    readonly deviceId?: string;
    readonly cachePath?: string;
  };
  readonly processFilter: 'active' | 'attention' | 'completed' | 'all';
  readonly jobsFilter: string;
  readonly panelTabs: Readonly<Record<string, string>>;
  readonly disclosures: Readonly<Record<string, boolean>>;
}

export interface UiPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export const DEFAULT_EDITOR_UI_PREFERENCES: EditorUiPreferencesV2 = {
  version: 2,
  workspacePreset: 'edit',
  viewMode: 'vertical',
  projectLibrary: { view: 'grid', sort: 'updated-desc' },
  assetLibrary: {
    source: 'cloud',
    category: 'all',
    view: 'medium',
    sort: 'name',
    collectionByCategory: {},
  },
  audioStudio: {},
  processFilter: 'all',
  jobsFilter: 'all',
  panelTabs: {},
  disclosures: {},
};

export function loadEditorUiPreferences(storage: UiPreferenceStorage): EditorUiPreferencesV2 {
  const raw = storage.getItem(EDITOR_UI_PREFERENCES_KEY);
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isEditorUiPreferencesV2(parsed)) return parsed;
    } catch {
      // Fall through to a safe, non-destructive default.
    }
  }

  const legacyViewMode = storage.getItem('joy-media.view-mode.v1');
  return {
    ...DEFAULT_EDITOR_UI_PREFERENCES,
    viewMode: legacyViewMode === 'widescreen' ? 'widescreen' : 'vertical',
  };
}

export function saveEditorUiPreferences(
  storage: UiPreferenceStorage,
  preferences: EditorUiPreferencesV2,
): void {
  storage.setItem(EDITOR_UI_PREFERENCES_KEY, JSON.stringify(preferences));
}

export function updateEditorUiPreferences(
  storage: UiPreferenceStorage,
  update: (current: EditorUiPreferencesV2) => EditorUiPreferencesV2,
): EditorUiPreferencesV2 {
  const next = update(loadEditorUiPreferences(storage));
  saveEditorUiPreferences(storage, next);
  return next;
}

export function resetEditorUiPreferences(storage: UiPreferenceStorage): EditorUiPreferencesV2 {
  storage.removeItem?.(EDITOR_UI_PREFERENCES_KEY);
  return loadEditorUiPreferences(storage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEditorUiPreferencesV2(value: unknown): value is EditorUiPreferencesV2 {
  if (!isRecord(value) || value.version !== 2) return false;
  if (
    value.workspacePreset !== 'edit' &&
    value.workspacePreset !== 'enhance' &&
    value.workspacePreset !== 'audio-captions' &&
    value.workspacePreset !== 'automate' &&
    value.workspacePreset !== 'custom'
  )
    return false;
  if (value.viewMode !== 'vertical' && value.viewMode !== 'widescreen') return false;
  if (!isRecord(value.projectLibrary) || !isRecord(value.assetLibrary)) return false;
  if (value.projectLibrary.view !== 'grid' && value.projectLibrary.view !== 'list') return false;
  if (
    value.projectLibrary.sort !== 'updated-desc' &&
    value.projectLibrary.sort !== 'created-desc' &&
    value.projectLibrary.sort !== 'name-asc' &&
    value.projectLibrary.sort !== 'name-desc'
  )
    return false;
  if (value.assetLibrary.source !== 'user' && value.assetLibrary.source !== 'cloud') return false;
  if (
    value.assetLibrary.category !== 'all' &&
    value.assetLibrary.category !== 'video' &&
    value.assetLibrary.category !== 'audio' &&
    value.assetLibrary.category !== 'image'
  )
    return false;
  if (
    value.assetLibrary.view !== 'large' &&
    value.assetLibrary.view !== 'medium' &&
    value.assetLibrary.view !== 'list'
  )
    return false;
  return (
    typeof value.assetLibrary.sort === 'string' &&
    isRecord(value.assetLibrary.collectionByCategory) &&
    isRecord(value.audioStudio) &&
    typeof value.processFilter === 'string' &&
    typeof value.jobsFilter === 'string' &&
    isRecord(value.panelTabs) &&
    isRecord(value.disclosures)
  );
}
