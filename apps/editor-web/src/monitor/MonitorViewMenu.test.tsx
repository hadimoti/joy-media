// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EDITOR_UI_PREFERENCES_KEY,
  loadEditorUiPreferences,
  type UiPreferenceStorage,
} from '../ui-preferences.js';
import { DEFAULT_MONITOR_VIEW_OPTIONS, type MonitorViewOptions } from './monitor-view-options.js';
import { MonitorViewMenu, useMonitorViewOptions } from './MonitorViewMenu.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function storage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function mount(element: ReactElement) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

function openMenu() {
  const trigger = container?.querySelector<HTMLButtonElement>('[data-guide="View"]');
  expect(trigger).toBeTruthy();
  act(() => trigger?.click());
  return container?.querySelector<HTMLElement>('[role="dialog"][aria-label="Monitor view"]');
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (candidate) => candidate.textContent?.trim().startsWith(label),
  );
  if (found === undefined) throw new Error(`No button "${label}"`);
  return found;
}

describe('Monitor View menu', () => {
  it('opens as a named dialog with the switches, background and preview overlay', () => {
    mount(<MonitorViewMenu options={DEFAULT_MONITOR_VIEW_OPTIONS} onChange={() => undefined} />);
    expect(container?.querySelector('[role="dialog"]')).toBeNull();
    const dialog = openMenu();
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelectorAll('[role="switch"]')).toHaveLength(8);
    expect(dialog?.querySelector('[role="radiogroup"][aria-label="Background"]')).not.toBeNull();
    expect(
      dialog?.querySelector(
        '[role="radiogroup"][aria-label="Preview overlay (does not change your project)"]',
      ),
    ).not.toBeNull();
    expect(dialog?.textContent).not.toContain('Preview — view only');
  });

  it('reports each switch change with the rest of the options unchanged', () => {
    const onChange = vi.fn<(next: MonitorViewOptions) => void>();
    mount(<MonitorViewMenu options={DEFAULT_MONITOR_VIEW_OPTIONS} onChange={onChange} />);
    openMenu();
    act(() => button('Grid').click());
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_MONITOR_VIEW_OPTIONS, grid: true });
    act(() => button('Title safe area').click());
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_MONITOR_VIEW_OPTIONS,
      titleSafe: true,
    });
  });

  it('shows a switch that is on as checked', () => {
    mount(
      <MonitorViewMenu
        options={{ ...DEFAULT_MONITOR_VIEW_OPTIONS, centreMarks: true }}
        onChange={() => undefined}
      />,
    );
    openMenu();
    expect(button('Centre marks').getAttribute('aria-checked')).toBe('true');
    expect(button('Grid').getAttribute('aria-checked')).toBe('false');
  });

  it('offers the frame-rate and dropped-frames readout as a View switch', () => {
    const onChange = vi.fn<(next: MonitorViewOptions) => void>();
    mount(<MonitorViewMenu options={DEFAULT_MONITOR_VIEW_OPTIONS} onChange={onChange} />);
    openMenu();
    act(() => button('Frame rate and dropped frames').click());
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_MONITOR_VIEW_OPTIONS,
      showPerformanceStats: true,
    });
  });

  it('chooses the background and the preview overlay as one-of-several', () => {
    const onChange = vi.fn<(next: MonitorViewOptions) => void>();
    mount(<MonitorViewMenu options={DEFAULT_MONITOR_VIEW_OPTIONS} onChange={onChange} />);
    openMenu();
    act(() => button('Black').click());
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_MONITOR_VIEW_OPTIONS,
      background: 'black',
    });
    act(() => button('16:9').click());
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_MONITOR_VIEW_OPTIONS,
      previewAspect: '16:9',
    });
  });

  it('disables Clear guides when there are none', () => {
    mount(<MonitorViewMenu options={DEFAULT_MONITOR_VIEW_OPTIONS} onChange={() => undefined} />);
    openMenu();
    expect(button('Clear guides').disabled).toBe(true);
  });
});

describe('Monitor View options are saved per user', () => {
  function Harness({ store }: { readonly store: UiPreferenceStorage }) {
    const [options, setOptions] = useMonitorViewOptions(store);
    return (
      <>
        <span data-testid="saved-grid">{String(options.grid)}</span>
        <MonitorViewMenu options={options} onChange={setOptions} />
      </>
    );
  }

  it('writes a switch to the preferences and reads it back after a reload', () => {
    const store = storage();
    mount(<Harness store={store} />);
    openMenu();
    act(() => button('Grid').click());
    expect(container?.querySelector('[data-testid="saved-grid"]')?.textContent).toBe('true');
    expect(loadEditorUiPreferences(store).monitorView?.grid).toBe(true);

    act(() => root?.unmount());
    container?.remove();
    mount(<Harness store={store} />);
    expect(container?.querySelector('[data-testid="saved-grid"]')?.textContent).toBe('true');
  });

  it('keeps the view working for the session when storage refuses to save', () => {
    const store = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    mount(<Harness store={store} />);
    openMenu();
    act(() => button('Rulers and guides').click());
    expect(container?.querySelector('[data-testid="saved-grid"]')?.textContent).toBe('false');
    expect(button('Rulers and guides').getAttribute('aria-checked')).toBe('true');
  });

  it('keeps the preference key stable', () => {
    expect(EDITOR_UI_PREFERENCES_KEY).toBe('joy-media.editor-ui-preferences.v2');
  });
});
