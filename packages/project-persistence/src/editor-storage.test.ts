import { describe, expect, it } from 'vitest';
import { createEditorProjectStorageAdapter, isEditorProjectStorageKey } from './editor-storage.js';

function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    keys: () => [...values.keys()],
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
  };
}

describe('editor project storage adapter', () => {
  it('classifies project documents while leaving authentication and UI state in browser storage', () => {
    expect(isEditorProjectStorageKey('joy-media.timeline-project-log.v1')).toBe(true);
    expect(isEditorProjectStorageKey('joy-media.audio-graph.v1.project-1')).toBe(true);
    expect(isEditorProjectStorageKey('joy-media.login-contacts')).toBe(false);
    expect(isEditorProjectStorageKey('joy-media.editor-ui-preferences.v2')).toBe(false);
    expect(isEditorProjectStorageKey('auth_token')).toBe(false);
  });

  it('leaves browser-only keys in browser storage', () => {
    const browser = memoryStore();
    const desktop = memoryStore();
    const storage = createEditorProjectStorageAdapter(browser, desktop);

    storage.setItem('joy-media.editor-ui-preferences.v2', 'compact');

    expect(browser.getItem('joy-media.editor-ui-preferences.v2')).toBe('compact');
    expect(desktop.getItem('joy-media.editor-ui-preferences.v2')).toBeNull();
  });

  it('prefers SQLite values and reads legacy project values from browser storage', () => {
    const browser = memoryStore();
    const desktop = memoryStore();
    const storage = createEditorProjectStorageAdapter(browser, desktop);
    browser.setItem('joy-media.timeline-project-log.v1', 'legacy');
    desktop.setItem('joy-media.timeline-project-log.v1', 'sqlite');

    expect(storage.getItem('joy-media.timeline-project-log.v1')).toBe('sqlite');
    desktop.removeItem('joy-media.timeline-project-log.v1');
    expect(storage.getItem('joy-media.timeline-project-log.v1')).toBe('legacy');
  });

  it('writes project state to SQLite and removes its migrated browser copy', () => {
    const browser = memoryStore();
    const desktop = memoryStore();
    const storage = createEditorProjectStorageAdapter(browser, desktop);
    browser.setItem('joy-media.timeline-project-log.v1', 'legacy');

    storage.setItem('joy-media.timeline-project-log.v1', 'updated');

    expect(desktop.getItem('joy-media.timeline-project-log.v1')).toBe('updated');
    expect(browser.getItem('joy-media.timeline-project-log.v1')).toBeNull();
  });

  it('removes a project key from both stores', () => {
    const browser = memoryStore();
    const desktop = memoryStore();
    const storage = createEditorProjectStorageAdapter(browser, desktop);
    browser.setItem('joy-media.timeline-project-log.v1', 'legacy');
    desktop.setItem('joy-media.timeline-project-log.v1', 'sqlite');

    storage.removeItem?.('joy-media.timeline-project-log.v1');

    expect(browser.getItem('joy-media.timeline-project-log.v1')).toBeNull();
    expect(desktop.getItem('joy-media.timeline-project-log.v1')).toBeNull();
  });

  it('preserves storage enumeration for browser workflows and SQLite project documents', () => {
    const browser = memoryStore();
    const desktop = memoryStore();
    browser.setItem('joy-media.workflow.v1:index', '{"ids":[]}');
    desktop.setItem('joy-media.timeline-project-log.v1', '{"projects":{}}');
    const storage = createEditorProjectStorageAdapter(browser, desktop);
    const enumerated = storage as typeof storage & {
      readonly length?: number;
      key?(index: number): string | null;
    };

    expect(enumerated.length).toBe(2);
    expect([enumerated.key?.(0), enumerated.key?.(1)]).toEqual([
      'joy-media.workflow.v1:index',
      'joy-media.timeline-project-log.v1',
    ]);
  });
});
