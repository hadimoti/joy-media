import { describe, expect, it } from 'vitest';
import { BrowserProjectStore } from '@joy-media/project-persistence';
import type { ExportPresetId, JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import {
  EditorSession,
  TIMELINE_PROJECT_LOG_KEY,
  VISUAL_OBJECT_PROJECT_LOG_KEY,
} from './editor-session.js';
import type { ProjectCatalogEntry } from './project-catalog.js';
import { createBlankProjectDocuments, seedsForCatalogEntry } from './project-factory.js';

// Existing projects were saved before the New project form changed. Opening
// one must keep the canvas it was saved with, whatever the current default is.

const SAVED_AT = '2026-10-01T08:00:00.000Z';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function withoutExportPreset(doc: JoyProjectV1): JoyProjectV1 {
  const copy = { ...doc };
  delete copy.exportPreset;
  return copy;
}

function savedProject(
  id: string,
  canvas: { readonly width: number; readonly height: number },
  exportPreset: ExportPresetId | undefined,
): { readonly timeline: SpikeProject; readonly visual: JoyProjectV1 } {
  const { timeline, visual } = createBlankProjectDocuments(id, `${id} saved`, SAVED_AT, canvas);
  const visualSaved =
    exportPreset === undefined ? withoutExportPreset(visual) : { ...visual, exportPreset };
  return { timeline, visual: visualSaved };
}

function rootSize(doc: { readonly compositions: Record<string, unknown> }, id: string) {
  const root = doc.compositions[id] as { width: number; height: number };
  return { width: root.width, height: root.height };
}

const LANDSCAPE = { width: 1920, height: 1080 } as const;
const PORTRAIT = { width: 1080, height: 1920 } as const;

describe('existing projects open unchanged', () => {
  it('reopens a saved 16:9 project at 1920×1080 even when new projects default to 16:9 too', () => {
    const storage = memoryStorage();
    const saved = savedProject('landscape-old', LANDSCAPE, 'youtube-1080');
    new EditorSession(storage, saved.timeline, saved.visual);

    const defaults = createBlankProjectDocuments('landscape-old', 'Default', SAVED_AT);
    const reopened = new EditorSession(storage, defaults.timeline, defaults.visual);

    expect(rootSize(reopened.visualProject, 'root')).toEqual(LANDSCAPE);
    expect(rootSize(reopened.timelineProject, 'root')).toEqual(LANDSCAPE);
    expect(reopened.visualProject.exportPreset).toBe('youtube-1080');
  });

  it('reopens a saved 9:16 project at 1080×1920 even when the seeds offer 16:9', () => {
    const storage = memoryStorage();
    const saved = savedProject('portrait-old', PORTRAIT, 'reels-1080');
    new EditorSession(storage, saved.timeline, saved.visual);

    const defaults = createBlankProjectDocuments('portrait-old', 'Default', SAVED_AT);
    const reopened = new EditorSession(storage, defaults.timeline, defaults.visual);

    expect(rootSize(reopened.visualProject, 'root')).toEqual(PORTRAIT);
    expect(rootSize(reopened.timelineProject, 'root')).toEqual(PORTRAIT);
    expect(reopened.visualProject.exportPreset).toBe('reels-1080');
  });

  it('leaves a saved project without a stored export preset without one', () => {
    const storage = memoryStorage();
    const saved = savedProject('no-preset', LANDSCAPE, undefined);
    new EditorSession(storage, saved.timeline, saved.visual);

    const defaults = createBlankProjectDocuments('no-preset', 'Default', SAVED_AT);
    const reopened = new EditorSession(storage, defaults.timeline, defaults.visual);

    expect(rootSize(reopened.visualProject, 'root')).toEqual(LANDSCAPE);
    expect(reopened.visualProject.exportPreset).toBeUndefined();
  });
});

function catalogEntryFor(id: string): ProjectCatalogEntry {
  return {
    id,
    title: `${id} saved`,
    createdAt: SAVED_AT,
    updatedAt: SAVED_AT,
    timelineProjectId: id,
    visualProjectId: id,
  };
}

/** Saves both logs, drops one of them, then opens the project the way the library does. */
function openWithOneLogMissing(
  id: string,
  canvas: { readonly width: number; readonly height: number },
  exportPreset: ExportPresetId,
  missing: 'timeline' | 'visual',
): EditorSession {
  const storage = memoryStorage();
  const saved = savedProject(id, canvas, exportPreset);
  new EditorSession(storage, saved.timeline, saved.visual);
  const missingKey =
    missing === 'timeline' ? TIMELINE_PROJECT_LOG_KEY : VISUAL_OBJECT_PROJECT_LOG_KEY;
  new BrowserProjectStore(storage, missingKey).deleteProject(id);

  const seeds = seedsForCatalogEntry(catalogEntryFor(id));
  return new EditorSession(storage, seeds.timeline, seeds.visual);
}

describe('a saved project with one log missing opens on the saved canvas', () => {
  const cases = [
    ['16:9', LANDSCAPE, 'youtube-1080'],
    ['9:16', PORTRAIT, 'reels-1080'],
  ] as const;

  it.each(cases)(
    '%s, timeline log only: both logs agree and match the saved canvas',
    (_, canvas, preset) => {
      const reopened = openWithOneLogMissing(`tl-only-${canvas.width}`, canvas, preset, 'visual');

      expect(rootSize(reopened.timelineProject, 'root')).toEqual(canvas);
      expect(rootSize(reopened.visualProject, 'root')).toEqual(canvas);
    },
  );

  it.each(cases)(
    '%s, visual log only: both logs agree and match the saved canvas',
    (_, canvas, preset) => {
      const reopened = openWithOneLogMissing(
        `vis-only-${canvas.width}`,
        canvas,
        preset,
        'timeline',
      );

      expect(rootSize(reopened.timelineProject, 'root')).toEqual(canvas);
      expect(rootSize(reopened.visualProject, 'root')).toEqual(canvas);
      expect(reopened.visualProject.exportPreset).toBe(preset);
    },
  );
});
