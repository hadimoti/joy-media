import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { renderHeadlessFrame } from '@joy-media/renderer-headless';
import { buildRenderFrameIRFromProject } from '@joy-media/visual-object-renderer';
import type { CanvasReframeMode } from './canvas-reframe.js';
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

  it.each([
    ['16:9 into 9:16', 1920, 1080, 1080, 1920, 0.5625, 16 / 9],
    ['9:16 into 16:9', 1080, 1920, 1920, 1080, 0.5625, 16 / 9],
    ['4:3 into 16:9', 1440, 1080, 1920, 1080, 1, 4 / 3],
    ['small picture into 9:16', 1920, 1080, 1080, 1920, 0.5625, 16 / 9],
  ] as const)(
    'reframes every clip in Fit, Fill, or Keep positions for %s',
    (_case, oldWidth, oldHeight, nextWidth, nextHeight, fitScale, fillScale) => {
      const modes: readonly (readonly [CanvasReframeMode, number])[] = [
        ['fit', fitScale],
        ['fill', fillScale],
        ['keep', 1],
      ];
      for (const [mode, expectedScale] of modes) {
        const smallPicture = String(_case).startsWith('small picture');
        const { session } = sessionWithClips(oldWidth, oldHeight, smallPicture);
        const before = session.visualProject;

        expect(applyCanvasDimensions(session, nextWidth, nextHeight, 'Change canvas', mode)).toBe(
          true,
        );

        expect(session.visualProject.visualObjects['reframe-a']?.transform.scaleX).toBeCloseTo(
          (smallPicture ? 0.1 : 0.5) * expectedScale,
          8,
        );
        expect(session.visualProject.visualObjects['reframe-b']?.transform.scaleY).toBeCloseTo(
          1.5 * expectedScale,
          8,
        );
        if (mode === 'keep') {
          expect(session.visualProject.visualObjects['reframe-a']?.transform).toEqual(
            before.visualObjects['reframe-a']?.transform,
          );
        }

        session.undo();
        expect(session.visualProject.visualObjects['reframe-a']?.transform).toEqual(
          before.visualObjects['reframe-a']?.transform,
        );
        expect(session.visualProject.visualObjects['reframe-b']?.transform).toEqual(
          before.visualObjects['reframe-b']?.transform,
        );
      }
    },
  );

  it('scales hand-set positions around the canvas centre and restores all clips with one undo', () => {
    const { session } = sessionWithClips(1920, 1080);
    const before = session.visualProject;

    applyCanvasDimensions(session, 1080, 1920, 'Change canvas', 'fit');

    expect(session.visualProject.visualObjects['reframe-a']?.transform).toMatchObject({
      x: 596.25,
      y: 988.125,
      scaleX: 0.28125,
      scaleY: 0.421875,
    });
    expect(session.visualProject.visualObjects['reframe-b']?.transform).toMatchObject({
      x: 540,
      y: 960,
      scaleX: 0.84375,
      scaleY: 0.84375,
    });
    expect(session.historyEntries.at(-1)).toMatchObject({
      label: 'Change canvas',
      source: 'compound',
    });

    session.undo();
    expect(session.visualProject.visualObjects['reframe-a']?.transform).toEqual(
      before.visualObjects['reframe-a']?.transform,
    );
    expect(session.visualProject.visualObjects['reframe-b']?.transform).toEqual(
      before.visualObjects['reframe-b']?.transform,
    );
    expect(session.visualProject.compositions.root).toMatchObject({ width: 1920, height: 1080 });
  });

  it('keeps the preview-equivalent and export-snapshot frames equal after a reframe', () => {
    const { session } = sessionWithClips(1920, 1080);
    applyCanvasDimensions(session, 1080, 1920, 'Change canvas', 'fill');
    const previewProject = session.visualProject;
    const exportProject = JSON.parse(JSON.stringify(previewProject)) as typeof previewProject;
    const composition = previewProject.compositions[previewProject.rootCompositionId]!;
    const previewFrame = buildRenderFrameIRFromProject(
      previewProject,
      composition.id,
      500_000,
      composition.width,
      composition.height,
    );
    const exportFrame = buildRenderFrameIRFromProject(
      exportProject,
      composition.id,
      500_000,
      composition.width,
      composition.height,
    );

    expect(exportFrame).toEqual(previewFrame);
    expect(Array.from(renderHeadlessFrame(exportFrame).pixels)).toEqual(
      Array.from(renderHeadlessFrame(previewFrame).pixels),
    );
  });
});

function sessionWithClips(width: number, height: number, smallPicture = false) {
  const baseTimeline = buildReferenceSpikeProject();
  const timelineRootId = baseTimeline.rootCompositionId;
  const clips = [
    {
      id: 'reframe-clip-a',
      kind: 'video' as const,
      assetId: 'asset-a',
      startUs: 0,
      durationUs: 1_000_000,
      sourceInUs: 0,
    },
    {
      id: 'reframe-clip-b',
      kind: 'video' as const,
      assetId: 'asset-b',
      startUs: 1_000_000,
      durationUs: 1_000_000,
      sourceInUs: 0,
    },
  ];
  const initialTimeline = {
    ...baseTimeline,
    compositions: {
      ...baseTimeline.compositions,
      [timelineRootId]: {
        ...baseTimeline.compositions[timelineRootId]!,
        width,
        height,
        tracks: baseTimeline.compositions[timelineRootId]!.tracks.map((track, index) =>
          index === 0 ? { ...track, clips } : track,
        ),
      },
    },
  };
  const initialVisual = {
    ...INITIAL_EDITOR_PROJECT,
    exportPreset: 'custom' as const,
    compositions: {
      ...INITIAL_EDITOR_PROJECT.compositions,
      root: {
        ...INITIAL_EDITOR_PROJECT.compositions.root!,
        width,
        height,
        tracks: [
          {
            id: 'reframe-track',
            kind: 'video' as const,
            name: 'Video',
            order: 0,
            enabled: true,
            locked: false,
            clips,
          },
        ],
      },
    },
    assets: {
      ...INITIAL_EDITOR_PROJECT.assets,
      'asset-a': {
        id: 'asset-a',
        kind: 'image' as const,
        displayName: 'Wide picture',
        descriptor: {
          mimeType: 'image/png',
          width: smallPicture ? 320 : 1920,
          height: smallPicture ? 180 : 1080,
        },
      },
      'asset-b': {
        id: 'asset-b',
        kind: 'video' as const,
        displayName: 'Portrait video',
        descriptor: { mimeType: 'video/mp4', width: 1080, height: 1920 },
      },
    },
    visualObjects: {
      ...INITIAL_EDITOR_PROJECT.visualObjects,
      'reframe-a': {
        id: 'reframe-a',
        kind: 'image' as const,
        assetId: 'asset-a',
        transform: {
          x: width / 2 + 100,
          y: height / 2 + 50,
          scaleX: smallPicture ? 0.1 : 0.5,
          scaleY: smallPicture ? 0.1 : 0.75,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
      },
      'reframe-b': {
        id: 'reframe-b',
        kind: 'image' as const,
        assetId: 'asset-b',
        transform: {
          x: width / 2,
          y: height / 2,
          scaleX: 1.5,
          scaleY: 1.5,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
      },
    },
    pluginData: {
      ...INITIAL_EDITOR_PROJECT.pluginData,
      'joy.clipObjects': { 'reframe-clip-a': 'reframe-a', 'reframe-clip-b': 'reframe-b' },
    },
  };
  return { session: new EditorSession(memoryStorage(), initialTimeline, initialVisual) };
}
