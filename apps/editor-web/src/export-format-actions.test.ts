import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession } from './editor-session.js';
import { applyCanvasDimensions, applyExportPresetSelection } from './export-format-actions.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function sessionWithPortraitCanvas(storage = memoryStorage()) {
  const baseTimeline = buildReferenceSpikeProject();
  const timelineRootId = baseTimeline.rootCompositionId;
  const initialTimeline = {
    ...baseTimeline,
    compositions: {
      ...baseTimeline.compositions,
      [timelineRootId]: {
        ...baseTimeline.compositions[timelineRootId]!,
        width: 1080,
        height: 1920,
      },
    },
  };
  const initialVisual = {
    ...INITIAL_EDITOR_PROJECT,
    exportPreset: 'tiktok-1080' as const,
  };
  return {
    storage,
    initialTimeline,
    initialVisual,
    session: new EditorSession(storage, initialTimeline, initialVisual),
  };
}

describe('undoable export format changes', () => {
  it('changes preset and canvas in one undoable and persisted step', () => {
    const { storage, initialTimeline, initialVisual, session } = sessionWithPortraitCanvas();

    expect(applyExportPresetSelection(session, 'landscape-4k')).toBe(true);
    expect(session.visualProject.exportPreset).toBe('landscape-4k');
    expect(session.visualProject.compositions.root).toMatchObject({ width: 3840, height: 2160 });
    expect(
      session.timelineProject.compositions[session.timelineProject.rootCompositionId],
    ).toMatchObject({ width: 3840, height: 2160 });

    session.undo();
    expect(session.visualProject.exportPreset).toBe('tiktok-1080');
    expect(session.visualProject.compositions.root).toMatchObject({ width: 1080, height: 1920 });
    expect(
      session.timelineProject.compositions[session.timelineProject.rootCompositionId],
    ).toMatchObject({ width: 1080, height: 1920 });

    session.redo();
    const reopened = new EditorSession(storage, initialTimeline, initialVisual);
    expect(reopened.visualProject.exportPreset).toBe('landscape-4k');
    expect(reopened.visualProject.compositions.root).toMatchObject({ width: 3840, height: 2160 });
  });

  it('updates the matching preset and canvas together when a canvas size is selected', () => {
    const { session } = sessionWithPortraitCanvas();

    expect(applyCanvasDimensions(session, 1080, 1350)).toBe(true);
    expect(session.visualProject.exportPreset).toBe('instagram-feed-4x5');
    expect(session.visualProject.compositions.root).toMatchObject({ width: 1080, height: 1350 });

    session.undo();
    expect(session.visualProject.exportPreset).toBe('tiktok-1080');
    expect(session.visualProject.compositions.root).toMatchObject({ width: 1080, height: 1920 });
  });

  it('keeps the canvas when Custom is selected and makes that choice undoable', () => {
    const { session } = sessionWithPortraitCanvas();

    expect(applyExportPresetSelection(session, 'custom')).toBe(true);
    expect(session.visualProject.exportPreset).toBe('custom');
    expect(session.visualProject.compositions.root).toMatchObject({ width: 1080, height: 1920 });

    session.undo();
    expect(session.visualProject.exportPreset).toBe('tiktok-1080');
  });
});
