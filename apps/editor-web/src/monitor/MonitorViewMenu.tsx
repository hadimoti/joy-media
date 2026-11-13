import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { usePopup } from '../popup-manager.js';
import { POPUP_IDS } from '../popup-ids.js';
import {
  loadEditorUiPreferences,
  updateEditorUiPreferences,
  type UiPreferenceStorage,
} from '../ui-preferences.js';
import {
  MONITOR_BACKGROUNDS,
  MONITOR_PREVIEW_ASPECTS,
  withMonitorBackground,
  withMonitorSwitch,
  withPreviewAspect,
  withoutUserGuides,
  type MonitorBackground,
  type MonitorPreviewAspect,
  type MonitorViewOptions,
  type MonitorViewSwitch,
} from './monitor-view-options.js';

/** The id of the View popover, for `aria-controls`. */
export const MONITOR_VIEW_POPOVER_ID = 'monitor-view-menu';

const SWITCH_LABELS: Readonly<Record<MonitorViewSwitch, string>> = {
  titleSafe: 'Title safe area (80 %)',
  actionSafe: 'Action safe area (90 %)',
  grid: 'Grid',
  centreMarks: 'Centre marks',
  rulers: 'Rulers and guides',
  canvasBorder: 'Canvas border',
  pixelGrid: 'Pixel grid (from 800 %)',
  showPerformanceStats: 'Frame rate and dropped frames',
};

const SAFE_SWITCHES: readonly MonitorViewSwitch[] = ['titleSafe', 'actionSafe'];
const GUIDE_SWITCHES: readonly MonitorViewSwitch[] = [
  'grid',
  'centreMarks',
  'rulers',
  'canvasBorder',
  'pixelGrid',
];

const BACKGROUND_LABELS: Readonly<Record<MonitorBackground, string>> = {
  checkerboard: 'Checkerboard',
  black: 'Black',
  grey: 'Grey',
};

const ASPECT_LABELS: Readonly<Record<MonitorPreviewAspect, string>> = {
  none: 'None',
  '9:16': '9:16',
  '1:1': '1:1',
  '4:5': '4:5',
  '16:9': '16:9',
};

/**
 * The View options as React state, saved per user. A change is written to the
 * UI preferences at once; if the browser storage refuses, the view still works
 * for this session.
 */
export function useMonitorViewOptions(
  storage: UiPreferenceStorage,
): [MonitorViewOptions, Dispatch<SetStateAction<MonitorViewOptions>>] {
  const [options, setOptionsState] = useState<MonitorViewOptions>(() => {
    try {
      return loadEditorUiPreferences(storage).monitorView!;
    } catch {
      return loadEditorUiPreferences({ getItem: () => null, setItem: () => undefined })
        .monitorView!;
    }
  });
  const latest = useRef(options);
  const setOptions = useCallback<Dispatch<SetStateAction<MonitorViewOptions>>>(
    (update) => {
      const next = typeof update === 'function' ? update(latest.current) : update;
      latest.current = next;
      setOptionsState(next);
      try {
        updateEditorUiPreferences(storage, (current) => ({ ...current, monitorView: next }));
      } catch {
        // Storage refused (private window, blocked site data): keep the view for this session.
      }
    },
    [storage],
  );
  return [options, setOptions];
}

/** The "View" menu of the Monitor bar: switches, background and the Preview overlay. */
export function MonitorViewMenu({
  options,
  onChange,
}: {
  readonly options: MonitorViewOptions;
  readonly onChange: (next: MonitorViewOptions) => void;
}) {
  // The View popup: outside click, Escape and one popup open at a time (OB-18).
  const menu = usePopup(POPUP_IDS.monitorView);
  const renderSwitch = (key: MonitorViewSwitch) => {
    const on = options[key];
    return (
      <button
        key={key}
        type="button"
        role="switch"
        aria-checked={on}
        className="monitor-view-switch"
        title={`${SWITCH_LABELS[key]}: click to turn it ${on ? 'off' : 'on'}`}
        data-monitor-view-switch={key}
        onClick={() => onChange(withMonitorSwitch(options, key, !on))}
      >
        <span>{SWITCH_LABELS[key]}</span>
        <span className="monitor-view-state" aria-hidden="true">
          {on ? 'On' : 'Off'}
        </span>
      </button>
    );
  };
  return (
    <div className="monitor-view-root" ref={menu.rootRef}>
      <button
        type="button"
        className="monitor-transport-btn monitor-view-trigger"
        aria-haspopup="dialog"
        aria-expanded={menu.open}
        aria-controls={MONITOR_VIEW_POPOVER_ID}
        aria-pressed={menu.open}
        title="View: safe areas, grid, rulers, background and the preview overlay"
        data-guide="View"
        data-popup-trigger={POPUP_IDS.monitorView}
        onClick={(event) => menu.toggle(event.currentTarget)}
      >
        View
      </button>
      {menu.open && (
        <div
          id={MONITOR_VIEW_POPOVER_ID}
          className="monitor-view-menu"
          role="dialog"
          aria-label="Monitor view"
        >
          <div className="monitor-view-group" role="group" aria-label="Safe areas">
            <span className="monitor-view-group-label">Safe areas</span>
            {SAFE_SWITCHES.map(renderSwitch)}
          </div>
          <div className="monitor-view-group" role="group" aria-label="Guides and marks">
            <span className="monitor-view-group-label">Guides and marks</span>
            {GUIDE_SWITCHES.map(renderSwitch)}
            <button
              type="button"
              className="monitor-view-clear"
              title="Remove every guide you placed on the Monitor (your project is not changed)"
              disabled={options.guides.length === 0}
              onClick={() => onChange(withoutUserGuides(options))}
            >
              Clear guides
            </button>
          </div>
          <div className="monitor-view-group" role="group" aria-label="Performance">
            <span className="monitor-view-group-label">Performance</span>
            {(['showPerformanceStats'] as const).map(renderSwitch)}
          </div>
          <div className="monitor-view-group" role="radiogroup" aria-label="Background">
            <span className="monitor-view-group-label">Background</span>
            {MONITOR_BACKGROUNDS.map((background) => (
              <button
                key={background}
                type="button"
                role="radio"
                aria-checked={options.background === background}
                className="monitor-view-choice"
                title={`Background: ${BACKGROUND_LABELS[background]}`}
                data-monitor-background-option={background}
                onClick={() => onChange(withMonitorBackground(options, background))}
              >
                {BACKGROUND_LABELS[background]}
              </button>
            ))}
          </div>
          <div
            className="monitor-view-group"
            role="radiogroup"
            aria-label="Preview overlay (does not change your project)"
          >
            <span className="monitor-view-group-label">
              Preview overlay (does not change your project)
            </span>
            {MONITOR_PREVIEW_ASPECTS.map((aspect) => (
              <button
                key={aspect}
                type="button"
                role="radio"
                aria-checked={options.previewAspect === aspect}
                className="monitor-view-choice"
                title={`Preview aspect: ${ASPECT_LABELS[aspect]}`}
                data-monitor-preview-aspect={aspect}
                onClick={() => onChange(withPreviewAspect(options, aspect))}
              >
                {ASPECT_LABELS[aspect]}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
