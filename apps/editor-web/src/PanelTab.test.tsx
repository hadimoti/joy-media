// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IDockviewPanelHeaderProps } from 'dockview';
import { LABELLED_TAB_STRIP_WIDTH, PanelTab, stripHasRoomForLabels } from './PanelTab.js';
import { panelLabel, panelTabIconUrl } from './panel-tab-icons.js';
import { PANEL_IDS } from './workspace.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom has no ResizeObserver, and the tab only wants it to react to a
 *  strip whose width changes. The stub records that it was asked to watch. */
class StubResizeObserver {
  static observed: Element[] = [];
  static callback: ResizeObserverCallback | undefined;

  constructor(callback: ResizeObserverCallback) {
    StubResizeObserver.callback = callback;
  }

  observe(target: Element): void {
    StubResizeObserver.observed.push(target);
  }
  unobserve(): void {}
  disconnect(): void {}

  static notify(): void {
    StubResizeObserver.callback?.([], {} as ResizeObserver);
  }
}

/**
 * The app's stylesheet, read from the folder this test lives in.
 *
 * jsdom brings its own URL, and that URL resolves a relative path against
 * the page rather than against the file, so the path is built from the file
 * url of this module instead of from `new URL('./app.css', import.meta.url)`.
 */
const appCss = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'app.css'), 'utf8');

describe('PanelTab', () => {
  it('keeps the panel name available for the overflow menu and accessibility', () => {
    const props = { api: { id: 'media' } } as unknown as IDockviewPanelHeaderProps;
    const markup = renderToStaticMarkup(<PanelTab {...props} />);

    expect(markup).toContain('title="Create"');
    expect(markup).toContain('aria-label="Create"');
    expect(markup).toContain('class="panel-tab-label">Create</span>');
  });

  it('gives every icon-only tab a tooltip and an accessible name (OB-01b, OB-16c)', () => {
    for (const panelId of PANEL_IDS) {
      const props = { api: { id: panelId } } as unknown as IDockviewPanelHeaderProps;
      const markup = renderToStaticMarkup(<PanelTab {...props} />);
      const label = panelLabel(panelId);

      expect(markup, `${panelId} tooltip`).toContain(`title="${label}"`);
      expect(markup, `${panelId} accessible name`).toContain(`aria-label="${label}"`);
    }
  });

  it('draws the 3D tab with its own icon in the dock (OB-01a)', () => {
    const props = { api: { id: 'scene3d' } } as unknown as IDockviewPanelHeaderProps;
    const markup = renderToStaticMarkup(<PanelTab {...props} />);

    const cubeUrl = panelTabIconUrl('scene3d');
    expect(cubeUrl).toBeTruthy();
    expect(markup).toContain(cubeUrl as string);
    expect(cubeUrl).not.toBe(panelTabIconUrl('motion'));
  });
});

describe('the name on a dock tab (T-D09 review)', () => {
  let root: Root | undefined;
  let header: HTMLDivElement | undefined;
  let host: HTMLDivElement | undefined;

  beforeEach(() => {
    StubResizeObserver.observed = [];
    StubResizeObserver.callback = undefined;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
  });

  afterEach(async () => {
    if (root !== undefined) await act(async () => root?.unmount());
    header?.remove();
    root = undefined;
    header = undefined;
    host = undefined;
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  });

  const setClientWidth = (element: HTMLElement, width: number): void => {
    Object.defineProperty(element, 'clientWidth', { value: width, configurable: true });
  };

  const setRectWidth = (element: HTMLElement, width: number): void => {
    element.getBoundingClientRect = () =>
      ({
        width,
        height: 30,
        top: 0,
        right: width,
        bottom: 30,
        left: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  };

  /** Mirror Dockview 4.13.1: the content-sized scrollable is inside a fixed-width header. */
  async function renderTab(headerWidthPx: number): Promise<HTMLDivElement> {
    header = document.createElement('div');
    header.className = 'dv-tabs-and-actions-container';
    setClientWidth(header, headerWidthPx);

    const preActions = document.createElement('div');
    preActions.className = 'dv-pre-actions-container';
    setRectWidth(preActions, 0);
    const scrollable = document.createElement('div');
    scrollable.className = 'dv-scrollable';
    setClientWidth(scrollable, 300);
    const tabList = document.createElement('div');
    tabList.className = 'dv-tabs-container dv-horizontal';
    setClientWidth(tabList, 296);
    host = document.createElement('div');
    tabList.append(host);
    scrollable.append(tabList);
    const leftActions = document.createElement('div');
    leftActions.className = 'dv-left-actions-container';
    setRectWidth(leftActions, 0);
    const voidContainer = document.createElement('div');
    voidContainer.className = 'dv-void-container';
    setRectWidth(voidContainer, 200);
    const rightActions = document.createElement('div');
    rightActions.className = 'dv-right-actions-container';
    setRectWidth(rightActions, 70);
    header.append(preActions, scrollable, leftActions, voidContainer, rightActions);
    document.body.append(header);

    root = createRoot(host);
    const props = { api: { id: 'media' } } as unknown as IDockviewPanelHeaderProps;
    await act(async () => {
      root?.render(<PanelTab {...props} />);
    });
    return host;
  }

  const tabOf = (host: HTMLElement): HTMLElement | null =>
    host.querySelector<HTMLElement>('.panel-tab');

  it('measures available header space, not the content-sized scrollable child', async () => {
    const host = await renderTab(LABELLED_TAB_STRIP_WIDTH + 80);
    const tab = tabOf(host);

    expect(tab, 'the tab must be rendered').toBeTruthy();
    expect(tab?.getAttribute('data-labelled'), 'the wide tab is labelled').toBe('true');
    expect(StubResizeObserver.observed).toContain(header);
    expect(StubResizeObserver.observed).not.toContain(header?.querySelector('.dv-tabs-container'));
  });

  it('keeps flexible void space available to the tabs', async () => {
    const host = await renderTab(LABELLED_TAB_STRIP_WIDTH + 69);
    const tab = tabOf(host);

    expect(tab, 'the tab must be rendered').toBeTruthy();
    expect(tab?.hasAttribute('data-labelled'), 'the narrow tab is not labelled').toBe(false);
    expect(tab?.getAttribute('title')).toBe('Create');
    expect(tab?.getAttribute('aria-label')).toBe('Create');
    expect(host.querySelector('.panel-tab-label')?.textContent).toBe('Create');
  });

  it('uses hysteresis so names do not flip near the threshold', async () => {
    const host = await renderTab(LABELLED_TAB_STRIP_WIDTH + 80);
    const tab = tabOf(host);

    expect(tab?.getAttribute('data-labelled')).toBe('true');
    setClientWidth(header!, LABELLED_TAB_STRIP_WIDTH + 56);
    await act(async () => StubResizeObserver.notify());
    expect(tab?.getAttribute('data-labelled'), 'a labelled tab stays labelled above 456px').toBe(
      'true',
    );

    setClientWidth(header!, LABELLED_TAB_STRIP_WIDTH + 45);
    await act(async () => StubResizeObserver.notify());
    expect(tab?.hasAttribute('data-labelled'), 'a labelled tab turns off below 456px').toBe(false);

    setClientWidth(header!, LABELLED_TAB_STRIP_WIDTH + 60);
    await act(async () => StubResizeObserver.notify());
    expect(tab?.hasAttribute('data-labelled'), 'an icon tab waits for 480px').toBe(false);

    setClientWidth(header!, LABELLED_TAB_STRIP_WIDTH + 80);
    await act(async () => StubResizeObserver.notify());
    expect(tab?.getAttribute('data-labelled')).toBe('true');
  });

  it('uses separate on and off thresholds', () => {
    expect(stripHasRoomForLabels(LABELLED_TAB_STRIP_WIDTH)).toBe(true);
    expect(stripHasRoomForLabels(LABELLED_TAB_STRIP_WIDTH - 1)).toBe(false);
    expect(stripHasRoomForLabels(LABELLED_TAB_STRIP_WIDTH - 24, true)).toBe(true);
    expect(stripHasRoomForLabels(LABELLED_TAB_STRIP_WIDTH - 25, true)).toBe(false);
  });

  it('has the stylesheet that shows the name and hides it again', () => {
    // The name is hidden by default: an icon-only tab shows only its glyph.
    expect(appCss).toMatch(/\.panel-tab-label\s*\{\s*display:\s*none;/);

    // The active tab always shows its name, and so does every tab in a strip
    // with room. Both live in one rule, so they look the same.
    const shown =
      /\.panel-tab\[data-labelled='true'\] \.panel-tab-label,\s*#root \.workspace \.dv-active-tab \.panel-tab-label\s*\{([^}]*)\}/.exec(
        appCss,
      );
    expect(shown, 'the rule that shows the tab name must be found').toBeTruthy();
    expect(shown?.[1]).toContain('display: block');
    expect(shown?.[1]).toContain('text-overflow: ellipsis');

    // A tab with a name grows to fit it; an icon-only tab keeps its square.
    const grown =
      /\.panel-tab\[data-labelled='true'\],\s*#root \.workspace \.dv-active-tab \.panel-tab\s*\{([^}]*)\}/.exec(
        appCss,
      );
    expect(grown, 'the rule that widens a named tab must be found').toBeTruthy();
    expect(grown?.[1]).toContain('width: auto');
    expect(grown?.[1]).toContain('min-width: 2.25rem');
  });
});
