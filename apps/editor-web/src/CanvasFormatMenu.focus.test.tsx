// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { CANVAS_FORMAT_POPOVER_ID, CanvasFormatPopover } from './CanvasFormatMenu.js';
import { MonitorTransport, type MonitorTransportProps } from './monitor/MonitorTransport.js';
import { PopupProvider, usePopup, type PopupControl } from './popup-manager.js';
import { DEFAULT_MONITOR_VIEW_OPTIONS } from './monitor/monitor-view-options.js';
import { POPUP_IDS } from './popup-ids.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const idlePopup: PopupControl = {
  open: false,
  show: () => undefined,
  toggle: () => undefined,
  close: () => undefined,
  rootRef: () => undefined,
};

/**
 * Mirrors App.tsx: the Format popover is mounted in the header (under the header menu's root),
 * while the monitor read-out in the monitor transport is the trigger that opens it.
 */
function FormatHarness({ showStats = false }: { readonly showStats?: boolean }) {
  const formatMenu = usePopup(POPUP_IDS.canvasFormat);
  const props: MonitorTransportProps = {
    zoomDrawer: idlePopup,
    zoomFit: true,
    zoom: 1,
    onZoomFit: () => undefined,
    onZoomSet: () => undefined,
    zoomLabel: 'Fit',
    fullscreen: false,
    toggleFullscreen: () => undefined,
    playing: false,
    playheadUs: 0,
    durationUs: 0,
    hasTimelineContent: false,
    seek: () => undefined,
    togglePlayback: () => undefined,
    previewQuality: 'auto',
    activePreviewQuality: 'full',
    setPreviewQuality: () => undefined,
    performanceStats: { fps: 24, droppedFrames: 2 },
    formatMenu,
    width: 1920,
    height: 1080,
    canvasPresetId: 'youtube-1080',
    viewOptions: { ...DEFAULT_MONITOR_VIEW_OPTIONS, showPerformanceStats: showStats },
    onViewOptionsChange: () => undefined,
  };
  return (
    <>
      <div ref={formatMenu.rootRef} className="header-menu">
        {formatMenu.open && (
          <CanvasFormatPopover
            popup={formatMenu}
            width={1920}
            height={1080}
            presetId="youtube-1080"
            onApplyCanvas={() => undefined}
            onApplyPreset={() => undefined}
          />
        )}
      </div>
      <MonitorTransport {...props} />
    </>
  );
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(showStats = false) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <PopupProvider>
        <FormatHarness showStats={showStats} />
      </PopupProvider>,
    );
  });
  return host;
}

function monitorReadout(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('.monitor-format-readout');
  if (button === null) throw new Error('monitor read-out not rendered');
  return button;
}

function popover(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[id="${CANVAS_FORMAT_POPOVER_ID}"]`);
}

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe('Format popover opened from the monitor read-out', () => {
  it('shows pixel sizes for Preview quality and removes renderer and GPU status controls', () => {
    const host = mount();
    const quality = host.querySelector<HTMLSelectElement>('select[aria-label="Preview quality"]');
    expect(quality).not.toBeNull();
    expect(Array.from(quality?.options ?? []).map((option) => option.textContent)).toEqual([
      'Auto (1920 × 1080)',
      'Full (1920 × 1080)',
      'Half (960 × 540)',
      'Quarter (480 × 270)',
    ]);
    expect(quality?.querySelector('option[value="quarter"]')?.getAttribute('title')).toContain(
      'looks softer',
    );
    expect(host.querySelector('select[aria-label="Monitor preview renderer"]')).toBeNull();
    expect(host.textContent).not.toContain('Renderer');
    expect(host.querySelector('.monitor-preview-status')).toBeNull();
    expect(host.querySelector('.monitor-performance-readout')).toBeNull();
  });

  it('shows the FPS and dropped-frame readout when enabled in View', () => {
    const host = mount(true);
    expect(host.querySelector('.monitor-performance-readout')?.textContent).toBe(
      '24 FPS · 2 dropped',
    );
  });

  it('moves focus into the popover, onto its first control, when it opens', () => {
    const container = mount();
    const trigger = monitorReadout(container);

    act(() => trigger.click());

    const dialog = popover(container);
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-label')).toBe('Format');
    expect(document.activeElement).toBe(dialog?.querySelector('button'));
    expect(dialog?.contains(document.activeElement)).toBe(true);
  });

  it('returns focus to the monitor read-out when Escape closes it', () => {
    const container = mount();
    const trigger = monitorReadout(container);
    act(() => trigger.click());
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) throw new Error('nothing focused in the popover');

    act(() => {
      focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(popover(container)).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus to the monitor read-out after a canvas shape is chosen', () => {
    const container = mount();
    const trigger = monitorReadout(container);
    act(() => trigger.click());
    const shape = popover(container)?.querySelector<HTMLButtonElement>('.canvas-format-shape');
    if (shape === null || shape === undefined) throw new Error('no canvas shape button');

    act(() => shape.click());

    expect(popover(container)).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
