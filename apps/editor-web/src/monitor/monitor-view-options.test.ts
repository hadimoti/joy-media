import { describe, expect, it } from 'vitest';
import {
  loadEditorUiPreferences,
  updateEditorUiPreferences,
  DEFAULT_EDITOR_UI_PREFERENCES,
} from '../ui-preferences.js';
import {
  ACTION_SAFE_INSET,
  DEFAULT_MONITOR_VIEW_OPTIONS,
  MAX_USER_GUIDES,
  MONITOR_VIEW_SWITCHES,
  TITLE_SAFE_INSET,
  commitUserGuideDrag,
  gridPositions,
  isPixelGridShown,
  previewAspectRect,
  rulerStep,
  rulerTicks,
  safeAreaRect,
  sanitizeMonitorViewOptions,
  withMonitorBackground,
  withMonitorSwitch,
  withPreviewAspect,
  withoutUserGuides,
  type MonitorViewOptions,
  type MonitorViewSwitch,
} from './monitor-view-options.js';

function storage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

const FRAME = { width: 1920, height: 1080 };

describe('Monitor View options: defaults and saved values', () => {
  it('starts with every overlay off except the pixel grid, which only shows at 800 per cent', () => {
    expect(DEFAULT_MONITOR_VIEW_OPTIONS).toMatchObject({
      titleSafe: false,
      actionSafe: false,
      grid: false,
      centreMarks: false,
      rulers: false,
      canvasBorder: false,
      pixelGrid: true,
      showPerformanceStats: false,
      background: 'checkerboard',
      previewAspect: 'none',
      guides: [],
    });
    expect(DEFAULT_EDITOR_UI_PREFERENCES.monitorView).toEqual(DEFAULT_MONITOR_VIEW_OPTIONS);
  });

  it.each(MONITOR_VIEW_SWITCHES)('saves and restores the %s switch', (key: MonitorViewSwitch) => {
    const store = storage();
    const on = withMonitorSwitch(
      DEFAULT_MONITOR_VIEW_OPTIONS,
      key,
      !DEFAULT_MONITOR_VIEW_OPTIONS[key],
    );
    updateEditorUiPreferences(store, (current) => ({ ...current, monitorView: on }));
    // A fresh read, as after a reload, gives the same switch back.
    expect(loadEditorUiPreferences(store).monitorView?.[key]).toBe(
      !DEFAULT_MONITOR_VIEW_OPTIONS[key],
    );
    const off = withMonitorSwitch(on, key, DEFAULT_MONITOR_VIEW_OPTIONS[key]);
    updateEditorUiPreferences(store, (current) => ({ ...current, monitorView: off }));
    expect(loadEditorUiPreferences(store).monitorView).toEqual(off);
  });

  it('saves and restores the background, the preview aspect and the user guides together', () => {
    const store = storage();
    const chosen: MonitorViewOptions = {
      ...withPreviewAspect(withMonitorBackground(DEFAULT_MONITOR_VIEW_OPTIONS, 'grey'), '4:5'),
      guides: [
        { axis: 'x', position: 960 },
        { axis: 'y', position: 540 },
      ],
    };
    updateEditorUiPreferences(store, (current) => ({ ...current, monitorView: chosen }));
    expect(loadEditorUiPreferences(store).monitorView).toEqual(chosen);
  });

  it('keeps the other preferences when the View options are saved', () => {
    const store = storage();
    updateEditorUiPreferences(store, (current) => ({
      ...current,
      monitorView: withMonitorSwitch(DEFAULT_MONITOR_VIEW_OPTIONS, 'grid', true),
    }));
    const loaded = loadEditorUiPreferences(store);
    expect(loaded.monitorPreview).toEqual(DEFAULT_EDITOR_UI_PREFERENCES.monitorPreview);
    expect(loaded.workspacePreset).toBe('edit');
  });

  it('reads older preferences that have no View options as the defaults', () => {
    const store = storage({
      'joy-media.editor-ui-preferences.v2': JSON.stringify({
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
      }),
    });
    expect(loadEditorUiPreferences(store).monitorView).toEqual(DEFAULT_MONITOR_VIEW_OPTIONS);
  });
});

describe('sanitizeMonitorViewOptions', () => {
  it('returns the defaults for anything that is not an object', () => {
    expect(sanitizeMonitorViewOptions(undefined)).toEqual(DEFAULT_MONITOR_VIEW_OPTIONS);
    expect(sanitizeMonitorViewOptions('grid')).toEqual(DEFAULT_MONITOR_VIEW_OPTIONS);
    expect(sanitizeMonitorViewOptions([])).toEqual(DEFAULT_MONITOR_VIEW_OPTIONS);
  });

  it('falls back field by field, so one bad value keeps the others', () => {
    const cleaned = sanitizeMonitorViewOptions({
      titleSafe: true,
      grid: 'yes',
      background: 'purple',
      previewAspect: '3:2',
      guides: [
        { axis: 'x', position: 12 },
        { axis: 'z', position: 3 },
        { axis: 'y', position: NaN },
      ],
    });
    expect(cleaned.titleSafe).toBe(true);
    expect(cleaned.grid).toBe(false);
    expect(cleaned.background).toBe('checkerboard');
    expect(cleaned.previewAspect).toBe('none');
    expect(cleaned.guides).toEqual([{ axis: 'x', position: 12 }]);
  });

  it('caps the number of saved guides', () => {
    const many = Array.from({ length: MAX_USER_GUIDES + 10 }, (_, index) => ({
      axis: 'x',
      position: index,
    }));
    expect(sanitizeMonitorViewOptions({ guides: many }).guides).toHaveLength(MAX_USER_GUIDES);
  });
});

describe('switch and choice updates', () => {
  it('returns the same object when nothing changes', () => {
    expect(withMonitorSwitch(DEFAULT_MONITOR_VIEW_OPTIONS, 'grid', false)).toBe(
      DEFAULT_MONITOR_VIEW_OPTIONS,
    );
    expect(withMonitorBackground(DEFAULT_MONITOR_VIEW_OPTIONS, 'checkerboard')).toBe(
      DEFAULT_MONITOR_VIEW_OPTIONS,
    );
  });

  it('clears the user guides only', () => {
    const withGuide = {
      ...DEFAULT_MONITOR_VIEW_OPTIONS,
      rulers: true,
      guides: [{ axis: 'y' as const, position: 4 }],
    };
    expect(withoutUserGuides(withGuide)).toMatchObject({ rulers: true, guides: [] });
  });
});

describe('overlay geometry', () => {
  it('draws title safe at 10 per cent in from each side and action safe at 5 per cent', () => {
    expect(TITLE_SAFE_INSET).toBe(0.1);
    expect(ACTION_SAFE_INSET).toBe(0.05);
    expect(safeAreaRect(FRAME, TITLE_SAFE_INSET)).toEqual({
      x: 192,
      y: 108,
      width: 1536,
      height: 864,
    });
    expect(safeAreaRect(FRAME, ACTION_SAFE_INSET)).toEqual({
      x: 96,
      y: 54,
      width: 1728,
      height: 972,
    });
  });

  it('centres a 9:16 guide inside a 16:9 frame as a shaded mask cut-out', () => {
    const rect = previewAspectRect(FRAME, '9:16');
    expect(rect?.height).toBe(1080);
    expect(rect?.width).toBeCloseTo(607.5, 6);
    expect(rect?.x).toBeCloseTo((1920 - 607.5) / 2, 6);
    expect(rect?.y).toBe(0);
  });

  it('fits the other aspects and returns nothing for none or an empty frame', () => {
    expect(previewAspectRect(FRAME, '16:9')).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(previewAspectRect(FRAME, '1:1')).toMatchObject({
      x: 420,
      y: 0,
      width: 1080,
      height: 1080,
    });
    expect(previewAspectRect(FRAME, '4:5')).toMatchObject({ width: 864, height: 1080 });
    expect(previewAspectRect(FRAME, 'none')).toBeUndefined();
    expect(previewAspectRect({ width: 0, height: 0 }, '1:1')).toBeUndefined();
  });

  it('shows the pixel grid only from 800 per cent and only while the switch is on', () => {
    expect(isPixelGridShown(DEFAULT_MONITOR_VIEW_OPTIONS, 7.99)).toBe(false);
    expect(isPixelGridShown(DEFAULT_MONITOR_VIEW_OPTIONS, 8)).toBe(true);
    expect(isPixelGridShown({ ...DEFAULT_MONITOR_VIEW_OPTIONS, pixelGrid: false }, 8)).toBe(false);
  });

  it('places eight equal grid divisions on each side', () => {
    expect(gridPositions(800)).toEqual([100, 200, 300, 400, 500, 600, 700]);
  });
});

describe('rulers', () => {
  it('picks the smallest round step that keeps ticks 60 px apart on screen', () => {
    expect(rulerStep(1)).toBe(100);
    expect(rulerStep(0.1)).toBe(1000);
    expect(rulerStep(8)).toBe(10);
  });

  it('lists only the visible ticks, starting on a step boundary', () => {
    expect(rulerTicks(1920, 1, 230, 480)).toEqual([200, 300, 400]);
    expect(rulerTicks(1920, 1, -50, 150)).toEqual([0, 100]);
  });

  it('caps the tick count at deep zoom', () => {
    expect(rulerTicks(100000, 8, 0, 100000).length).toBeLessThanOrEqual(400);
  });
});

describe('user guides', () => {
  it('adds a guide dropped inside the frame and ignores one dropped outside', () => {
    expect(commitUserGuideDrag([], undefined, 'x', 960, FRAME)).toEqual([
      { axis: 'x', position: 960 },
    ]);
    expect(commitUserGuideDrag([], undefined, 'y', 1200, FRAME)).toEqual([]);
  });

  it('moves a guide that stays inside, and removes one dragged off the frame', () => {
    const guides = [
      { axis: 'x' as const, position: 100 },
      { axis: 'y' as const, position: 50 },
    ];
    expect(commitUserGuideDrag(guides, 1, 'y', 400, FRAME)).toEqual([
      { axis: 'x', position: 100 },
      { axis: 'y', position: 400 },
    ]);
    expect(commitUserGuideDrag(guides, 0, 'x', -5, FRAME)).toEqual([{ axis: 'y', position: 50 }]);
  });

  it('does not add past the cap', () => {
    const full = Array.from({ length: MAX_USER_GUIDES }, (_, index) => ({
      axis: 'x' as const,
      position: index,
    }));
    expect(commitUserGuideDrag(full, undefined, 'x', 5, FRAME)).toHaveLength(MAX_USER_GUIDES);
  });
});
