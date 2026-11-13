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
  static watched = 0;
  constructor(_callback: () => void) {}
  observe(): void {
    StubResizeObserver.watched += 1;
  }
  unobserve(): void {}
  disconnect(): void {}
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
  let container: HTMLDivElement | undefined;
  let strip: HTMLDivElement | undefined;

  beforeEach(() => {
    StubResizeObserver.watched = 0;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
  });

  afterEach(async () => {
    if (root !== undefined) await act(async () => root?.unmount());
    container?.remove();
    strip?.remove();
    root = undefined;
    container = undefined;
    strip = undefined;
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  });

  /** Render one tab in a header whose tab-list width may differ from its actions. */
  async function renderTab(
    stripWidthPx: number,
    tabListWidthPx = stripWidthPx,
  ): Promise<HTMLDivElement> {
    strip = document.createElement('div');
    strip.className = 'dv-tabs-and-actions-container';
    Object.defineProperty(strip, 'clientWidth', { value: stripWidthPx, configurable: true });
    const tabList = document.createElement('div');
    tabList.className = 'dv-tabs-container';
    Object.defineProperty(tabList, 'clientWidth', { value: tabListWidthPx, configurable: true });
    container = document.createElement('div');
    tabList.append(container);
    strip.append(tabList);
    document.body.append(strip);

    root = createRoot(container);
    const props = { api: { id: 'media' } } as unknown as IDockviewPanelHeaderProps;
    await act(async () => {
      root?.render(<PanelTab {...props} />);
    });
    return container;
  }

  const tabOf = (host: HTMLElement): HTMLElement | null =>
    host.querySelector<HTMLElement>('.panel-tab');

  it('names every tab when the strip is wide enough', async () => {
    const host = await renderTab(LABELLED_TAB_STRIP_WIDTH);
    const tab = tabOf(host);

    expect(tab, 'the tab must be rendered').toBeTruthy();
    // The tab carries the mark that shows its name; the stylesheet turns
    // that mark into a visible label.
    expect(tab?.getAttribute('data-labelled'), 'the wide tab is labelled').toBe('true');
    expect(StubResizeObserver.watched, 'the tab watches the strip').toBe(1);
  });

  it('keeps the tab icon-only when the strip is narrow, but still names it', async () => {
    const host = await renderTab(LABELLED_TAB_STRIP_WIDTH - 1);
    const tab = tabOf(host);

    expect(tab, 'the tab must be rendered').toBeTruthy();
    // No mark, so the stylesheet leaves the name hidden.
    expect(tab?.hasAttribute('data-labelled'), 'the narrow tab is not labelled').toBe(false);
    // The name is still there for the tooltip and for a screen reader.
    expect(tab?.getAttribute('title')).toBe('Create');
    expect(tab?.getAttribute('aria-label')).toBe('Create');
    expect(host.querySelector('.panel-tab-label')?.textContent).toBe('Create');
  });

  it('does not force every tab label on when header actions leave less room for the tab list', async () => {
    const host = await renderTab(LABELLED_TAB_STRIP_WIDTH + 80, LABELLED_TAB_STRIP_WIDTH - 1);
    const tab = tabOf(host);

    expect(tab?.hasAttribute('data-labelled'), 'the available tab list is still narrow').toBe(
      false,
    );
    expect(StubResizeObserver.watched, 'the tab watches the actual tab list').toBe(1);
  });

  it('knows where the strip stops having room', () => {
    expect(stripHasRoomForLabels(LABELLED_TAB_STRIP_WIDTH)).toBe(true);
    expect(stripHasRoomForLabels(LABELLED_TAB_STRIP_WIDTH - 1)).toBe(false);
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
