import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EDITOR_UI_PREFERENCES,
  EDITOR_UI_PREFERENCES_KEY,
  loadEditorUiPreferences,
  resetEditorUiPreferences,
  saveEditorUiPreferences,
} from './ui-preferences.js';

function storage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('editor UI preferences', () => {
  it('migrates the existing view mode without touching project data', () => {
    const store = storage({ 'joy-media.view-mode.v1': 'widescreen' });
    expect(loadEditorUiPreferences(store)).toMatchObject({
      version: 2,
      workspacePreset: 'edit',
      viewMode: 'widescreen',
    });
    expect(store.getItem('joy-media.view-mode.v1')).toBe('widescreen');
  });

  it('rejects malformed preferences and falls back safely', () => {
    const store = storage({ [EDITOR_UI_PREFERENCES_KEY]: '{"version":2}' });
    expect(loadEditorUiPreferences(store)).toEqual(DEFAULT_EDITOR_UI_PREFERENCES);
  });

  it('round-trips and resets only UI preferences', () => {
    const store = storage();
    const next = { ...DEFAULT_EDITOR_UI_PREFERENCES, workspacePreset: 'enhance' as const };
    saveEditorUiPreferences(store, next);
    expect(loadEditorUiPreferences(store)).toEqual(next);
    expect(resetEditorUiPreferences(store)).toEqual(DEFAULT_EDITOR_UI_PREFERENCES);
  });

  it('migrates the old default Quarter preview and drops the removed renderer setting', () => {
    const store = storage({
      [EDITOR_UI_PREFERENCES_KEY]: JSON.stringify({
        ...DEFAULT_EDITOR_UI_PREFERENCES,
        monitorPreview: { quality: 'quarter', renderer: 'auto' },
      }),
    });

    expect(DEFAULT_EDITOR_UI_PREFERENCES.monitorPreview).toEqual({ quality: 'auto' });
    expect(loadEditorUiPreferences(store).monitorPreview).toEqual({ quality: 'auto' });
  });
});

describe('the default view mode is preview-first (T-D12)', () => {
  it('gives a fresh profile the widescreen view mode', () => {
    expect(loadEditorUiPreferences(storage()).viewMode).toBe('widescreen');
    expect(DEFAULT_EDITOR_UI_PREFERENCES.viewMode).toBe('widescreen');
  });

  it('keeps a legacy saved vertical choice', () => {
    expect(
      loadEditorUiPreferences(storage({ 'joy-media.view-mode.v1': 'vertical' })).viewMode,
    ).toBe('vertical');
  });
});

describe('the view mode from stored values (T-D12 round 2)', () => {
  const layoutKey = (mode: 'vertical' | 'widescreen') => `joy-media.dockview.${mode}.v12`;

  it('a saved preference blob with viewMode vertical restores as vertical', () => {
    const blob = { ...DEFAULT_EDITOR_UI_PREFERENCES, viewMode: 'vertical' };
    expect(
      loadEditorUiPreferences(storage({ [EDITOR_UI_PREFERENCES_KEY]: JSON.stringify(blob) }))
        .viewMode,
    ).toBe('vertical');
  });

  it('a malformed blob with no layouts saved falls back to widescreen', () => {
    expect(
      loadEditorUiPreferences(storage({ [EDITOR_UI_PREFERENCES_KEY]: '{not json' })).viewMode,
    ).toBe('widescreen');
  });

  it('a malformed viewMode makes the blob unreadable: the saved layouts decide the mode', () => {
    const blob = { ...DEFAULT_EDITOR_UI_PREFERENCES, viewMode: 'sideways' };
    expect(
      loadEditorUiPreferences(
        storage({
          [EDITOR_UI_PREFERENCES_KEY]: JSON.stringify(blob),
          [layoutKey('vertical')]: '{"grid":{}}',
        }),
      ).viewMode,
    ).toBe('vertical');
    expect(
      loadEditorUiPreferences(
        storage({
          [EDITOR_UI_PREFERENCES_KEY]: '{not json',
          [layoutKey('vertical')]: '{"grid":{}}',
        }),
      ).viewMode,
    ).toBe('vertical');
  });

  it('with no readable preferences, a saved vertical layout and no widescreen layout means vertical', () => {
    expect(
      loadEditorUiPreferences(storage({ [layoutKey('vertical')]: '{"grid":{}}' })).viewMode,
    ).toBe('vertical');
  });

  it('with both layouts saved and no readable preferences, the default widescreen applies', () => {
    expect(
      loadEditorUiPreferences(
        storage({
          [layoutKey('vertical')]: '{"grid":{}}',
          [layoutKey('widescreen')]: '{"grid":{}}',
        }),
      ).viewMode,
    ).toBe('widescreen');
  });
});
