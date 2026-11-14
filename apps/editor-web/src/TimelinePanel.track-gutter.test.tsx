// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fitPixelsPerSecond } from '@joy-media/timeline-engine';
import { emptySpikeProject } from '@joy-media/test-fixtures';
import { TimelinePanel } from './TimelinePanel.js';
import { TIMELINE_TRACK_GUTTER_STORAGE_KEY } from './TimelineTrackGutterHandle.js';
import { readTimelineElementKindMap } from './timeline-element-kind.js';
import { buildTimelineElementsShowcase } from './timeline-elements-showcase.js';
import { TIMELINE_AUDIO_TRACK_MIN_HEIGHT_PX } from './timeline-layout.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The name sits in a variable on purpose: a literal `new URL('./app.css', …)`
// is an asset import to the bundler, not a path on disk.
const appCssName = './app.css';
const appCss = readFileSync(fileURLToPath(new URL(appCssName, import.meta.url)), 'utf8');

/** The body of the last top-level rule whose selector list is exactly `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...appCss.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  const body = matches.at(-1)?.[1];
  if (body === undefined) throw new Error(`no rule for ${selector}`);
  return body;
}

const DURATION_US = 30_000_000;

interface Mounted {
  readonly container: HTMLElement;
  readonly root: Root;
  readonly onViewportChange: ReturnType<typeof vi.fn>;
}

async function mount(options: { autoFit?: boolean } = {}): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onViewportChange = vi.fn();
  const noop = vi.fn();
  await act(async () => {
    root.render(
      <TimelinePanel
        project={emptySpikeProject({ trackCount: 2, durationUs: DURATION_US })}
        playheadUs={0}
        playing={false}
        selectedIds={[]}
        viewport={{ originUs: 0, pixelsPerSecond: 20 }}
        onViewportChange={onViewportChange}
        autoFit={options.autoFit ?? false}
        onAutoFitChange={noop}
        onTogglePlayback={noop}
        onSeek={noop}
        onToggleSelection={noop}
        onClearSelection={noop}
        onDispatch={noop}
      />,
    );
  });
  return { container, root, onViewportChange };
}

async function unmount({ container, root }: Mounted): Promise<void> {
  await act(async () => root.unmount());
  container.remove();
}

const panelOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('.timeline-panel')!;
const handleOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[role="separator"][aria-label="Resize track titles"]')!;
const gutterOf = (container: HTMLElement) =>
  panelOf(container).style.getPropertyValue('--timeline-track-gutter-width');

async function press(target: HTMLElement, key: string, shiftKey = false): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
  });
}

function pointer(type: string, clientX: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 7 });
  return event;
}

describe('Timeline track titles resize', () => {
  let widths: { panel: number; tracks: number };

  beforeEach(() => {
    class ResizeObserverStub {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    widths = { panel: 0, tracks: 0 };
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList.contains('timeline-panel')) return widths.panel;
        if (this.classList.contains('timeline-tracks')) return widths.tracks;
        return 0;
      },
    });
    window.localStorage.clear();
  });

  afterEach(() => {
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('writes the gutter width to the panel as the CSS variable and exposes the separator', async () => {
    const mounted = await mount();
    expect(gutterOf(mounted.container)).toBe('168px');
    const handle = handleOf(mounted.container);
    expect(handle).not.toBeNull();
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-valuenow')).toBe('168');
    expect(handle.getAttribute('aria-valuemin')).toBe('120');
    expect(handle.getAttribute('aria-valuemax')).toBe('420');
    expect(handle.tabIndex).toBe(0);
    // Outside the scroll container, so it never scrolls away with the tracks.
    expect(handle.closest('.timeline-tracks')).toBeNull();
    expect(handle.parentElement?.classList.contains('timeline-tracks-frame')).toBe(true);
    // Not inside a draggable track header: dragging it never starts a track reorder.
    expect(handle.closest('[draggable="true"]')).toBeNull();
    await unmount(mounted);
  });

  it('resizes by 8 px with the arrows, 32 px with Shift, resets with Home and holds the limits', async () => {
    const mounted = await mount();
    const handle = handleOf(mounted.container);
    await press(handle, 'ArrowRight');
    expect(gutterOf(mounted.container)).toBe('176px');
    await press(handle, 'ArrowRight', true);
    expect(gutterOf(mounted.container)).toBe('208px');
    await press(handle, 'ArrowLeft');
    expect(gutterOf(mounted.container)).toBe('200px');
    await press(handle, 'ArrowLeft', true);
    expect(gutterOf(mounted.container)).toBe('168px');
    for (let index = 0; index < 20; index += 1) await press(handle, 'ArrowLeft', true);
    expect(gutterOf(mounted.container)).toBe('120px');
    for (let index = 0; index < 20; index += 1) await press(handle, 'ArrowRight', true);
    expect(gutterOf(mounted.container)).toBe('420px');
    expect(handle.getAttribute('aria-valuenow')).toBe('420');
    await press(handle, 'Home');
    expect(gutterOf(mounted.container)).toBe('168px');
    await unmount(mounted);
  });

  it('caps the titles at 40 percent of a narrow panel', async () => {
    widths.panel = 600;
    const mounted = await mount();
    const handle = handleOf(mounted.container);
    expect(handle.getAttribute('aria-valuemax')).toBe('240');
    for (let index = 0; index < 10; index += 1) await press(handle, 'ArrowRight', true);
    expect(gutterOf(mounted.container)).toBe('240px');
    await unmount(mounted);
  });

  it('follows a pointer drag live, remembers the width, and resets on double click', async () => {
    const mounted = await mount();
    const handle = handleOf(mounted.container);
    await act(async () => {
      handle.dispatchEvent(pointer('pointerdown', 100));
    });
    expect(handle.classList.contains('is-dragging')).toBe(true);
    await act(async () => {
      handle.dispatchEvent(pointer('pointermove', 160));
    });
    expect(gutterOf(mounted.container)).toBe('228px');
    expect(window.localStorage.getItem(TIMELINE_TRACK_GUTTER_STORAGE_KEY)).toBeNull();
    await act(async () => {
      handle.dispatchEvent(pointer('pointermove', 900));
    });
    expect(gutterOf(mounted.container)).toBe('420px');
    await act(async () => {
      handle.dispatchEvent(pointer('pointermove', 150));
      handle.dispatchEvent(pointer('pointerup', 150));
    });
    expect(handle.classList.contains('is-dragging')).toBe(false);
    expect(gutterOf(mounted.container)).toBe('218px');
    expect(window.localStorage.getItem(TIMELINE_TRACK_GUTTER_STORAGE_KEY)).toBe('218');

    await act(async () => {
      handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    });
    expect(gutterOf(mounted.container)).toBe('168px');
    expect(window.localStorage.getItem(TIMELINE_TRACK_GUTTER_STORAGE_KEY)).toBe('168');
    await unmount(mounted);
  });

  it('restores the remembered width and works when storage is broken', async () => {
    window.localStorage.setItem(TIMELINE_TRACK_GUTTER_STORAGE_KEY, '260');
    const restored = await mount();
    expect(gutterOf(restored.container)).toBe('260px');
    await unmount(restored);

    window.localStorage.setItem(TIMELINE_TRACK_GUTTER_STORAGE_KEY, 'wide');
    const garbage = await mount();
    expect(gutterOf(garbage.container)).toBe('168px');
    await unmount(garbage);

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const blocked = await mount();
    expect(gutterOf(blocked.container)).toBe('168px');
    await press(handleOf(blocked.container), 'ArrowRight');
    expect(gutterOf(blocked.container)).toBe('176px');
    await unmount(blocked);
  });

  it('fits the lanes to the scroll width minus the dragged gutter', async () => {
    widths.tracks = 1_000;
    const mounted = await mount({ autoFit: true });
    const lastPps = () =>
      (mounted.onViewportChange.mock.calls.at(-1)?.[0] as { pixelsPerSecond: number })
        .pixelsPerSecond;
    expect(lastPps()).toBeCloseTo(fitPixelsPerSecond(DURATION_US, 1_000 - 168));
    await press(handleOf(mounted.container), 'ArrowRight', true);
    expect(lastPps()).toBeCloseTo(fitPixelsPerSecond(DURATION_US, 1_000 - 200));
    await unmount(mounted);
  });
});

describe('Timeline track rows and the bottom of the panel', () => {
  beforeEach(() => {
    class ResizeObserverStub {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('draws audio rows tall enough for code, name and one chip line; visual rows keep their height', async () => {
    const { timeline, visual } = buildTimelineElementsShowcase();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const noop = vi.fn();
    await act(async () => {
      root.render(
        <TimelinePanel
          project={timeline}
          elementKinds={readTimelineElementKindMap(visual)}
          playheadUs={0}
          playing={false}
          selectedIds={[]}
          trackFlags={timeline.compositions.root!.tracks.map((track, order) => ({
            id: track.id,
            heightPx: 44,
            locked: false,
            visible: true,
            solo: false,
            order,
          }))}
          viewport={{ originUs: 0, pixelsPerSecond: 20 }}
          onViewportChange={noop}
          autoFit={false}
          onAutoFitChange={noop}
          onTogglePlayback={noop}
          onSeek={noop}
          onToggleSelection={noop}
          onClearSelection={noop}
          onDispatch={noop}
        />,
      );
    });
    const audioRows = container.querySelectorAll<HTMLElement>(
      '.timeline-track[data-track-family="audio"]',
    );
    const visualRows = container.querySelectorAll<HTMLElement>(
      '.timeline-track[data-track-family="visual"]:not(.timeline-runway)',
    );
    expect(audioRows.length).toBeGreaterThan(0);
    expect(visualRows.length).toBeGreaterThan(0);
    for (const row of audioRows) {
      if (row.classList.contains('timeline-runway')) continue;
      expect(row.style.height).toBe(`${TIMELINE_AUDIO_TRACK_MIN_HEIGHT_PX}px`);
      expect(row.querySelector('.timeline-audio-dsp-pills')).not.toBeNull();
    }
    for (const row of visualRows) expect(row.style.height).toBe('44px');
    await act(async () => root.unmount());
    container.remove();
  });

  it('keeps the audio row height above its header content measured from the CSS', () => {
    const rem = 16;
    const typeXs = parseFloat(/--joy-type-xs:\s*([\d.]+)rem/.exec(appCss)![1]!) * rem;
    const labelLineHeight = parseFloat(
      /line-height:\s*([\d.]+)/.exec(ruleBody('.timeline-track-label'))![1]!,
    );
    const pills = ruleBody('.timeline-audio-dsp-pills');
    const pill = ruleBody('.audio-dsp-pill');
    const pillLineHeight = parseFloat(/line-height:\s*([\d.]+)/.exec(pill)![1]!);
    const pillsHeightRule = /height:\s*calc\(var\(--joy-type-xs\) \* ([\d.]+) \+ (\d+)px\)/.exec(
      pills,
    )!;
    const pillsHeight = typeXs * parseFloat(pillsHeightRule[1]!) + parseFloat(pillsHeightRule[2]!);
    const pillOuter = typeXs * pillLineHeight + 2; // 1 px border top and bottom, no vertical padding
    const pillsMarginTop = parseFloat(/margin-top:\s*(\d+)px/.exec(pills)![1]!);
    // One chip line exactly: a wrapped second line is hidden in full, never cut.
    expect(pillsHeight).toBeCloseTo(pillOuter);
    expect(pills).toMatch(/flex-wrap:\s*wrap;/);
    expect(pills).toMatch(/overflow:\s*hidden;/);
    expect(pill).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(pill).toMatch(/flex:\s*none;/);
    const content = typeXs * labelLineHeight * 2 + pillsMarginTop + pillsHeight;
    const rowBorder = 1;
    // 13.8 + 13.8 + 2 + 17 = 46.6 px; at least 3 px of air above and below.
    expect(content + rowBorder + 6).toBeLessThanOrEqual(TIMELINE_AUDIO_TRACK_MIN_HEIGHT_PX);
  });

  it('lets the lane area and the titles column run to the rounded bottom of the panel', () => {
    const frame = ruleBody('.timeline-tracks-frame');
    expect(frame).toMatch(/flex:\s*1 1 auto;/);
    expect(frame).toMatch(/min-height:\s*0;/);
    expect(frame).toMatch(/border-radius:\s*var\(--joy-radius-inner\);/);
    // The titles column and the lane surface are painted by the frame itself.
    expect(frame).toMatch(/var\(--timeline-gutter-bg\) 0 var\(--timeline-track-gutter-width\)/);
    expect(frame).toMatch(/var\(--timeline-lane-bg\)/);

    const tracks = ruleBody('.timeline-tracks');
    expect(tracks).toMatch(/flex-direction:\s*column;/);
    expect(tracks).toMatch(/overflow:\s*auto;/);
    expect(tracks).toMatch(/min-height:\s*0;/);

    const inner = ruleBody('.timeline-tracks-inner');
    expect(inner).toMatch(/flex:\s*1 0 auto;/);
    expect(inner).toMatch(/align-content:\s*start;/);

    const panel = ruleBody('.timeline-panel');
    const padding = /padding:\s*([\d.]+)rem ([\d.]+)rem ([\d.]+)rem;/.exec(panel)!;
    expect(padding[3]).toBe(padding[2]);

    const header = ruleBody('.timeline-panel .timeline-track-header');
    expect(header).toMatch(/position:\s*sticky;/);
    expect(header).toMatch(/left:\s*0;/);
    expect(header).toMatch(/align-self:\s*stretch;/);
  });

  it('gives the resize handle an 8 px hit area with a 1 px line that turns theme yellow', () => {
    const handle = ruleBody('.timeline-gutter-resizer');
    expect(parseFloat(/width:\s*(\d+)px;/.exec(handle)![1]!)).toBeGreaterThanOrEqual(8);
    expect(handle).toMatch(/cursor:\s*col-resize;/);
    expect(handle).toMatch(/left:\s*calc\(var\(--timeline-track-gutter-width\) - 8px\);/);
    expect(ruleBody('.timeline-gutter-resizer::after')).toMatch(/width:\s*1px;/);
    expect(appCss).toMatch(
      /\.timeline-gutter-resizer:hover::after,\s*\.timeline-gutter-resizer:focus-visible::after,\s*\.timeline-gutter-resizer\.is-dragging::after\s*\{\s*background:\s*var\(--joy-accent\);/,
    );
  });
});
