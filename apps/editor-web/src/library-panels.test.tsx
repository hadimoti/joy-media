// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EFFECT_FAVORITES_KEY } from './effect-favorites.js';
import { librarySearch } from './library-search.js';

vi.mock('./editor-panel-context.js', async () => {
  const { createContext } = await import('react');
  return { EditorPanelContext: createContext(undefined) };
});

vi.mock('./EffectPreviewMedia.js', () => ({
  EffectPreviewMedia: ({ effectId }: { readonly effectId: string }) => (
    <div data-effect-preview={effectId} />
  ),
}));

import { EditorPanelContext, type EditorPanelContextValue } from './editor-panel-context.js';
import { FiltersPanel } from './FiltersPanel.js';
import { EffectsPanel } from './EffectsPanel.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no 2D canvas; the effect registry pulls in pixi, which asks for
// one when it loads.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const onEnhanceToolChange = vi.fn();
const storageMap = new Map<string, string>();

const storage = {
  getItem: (key: string) => storageMap.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storageMap.set(key, value);
  },
  removeItem: (key: string) => {
    storageMap.delete(key);
  },
};

const contextValue = {
  storage,
  onEnhanceToolChange,
} as unknown as EditorPanelContextValue;

beforeEach(() => {
  storageMap.clear();
  onEnhanceToolChange.mockClear();
  librarySearch.set({ query: '' });
});

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  librarySearch.set({ query: '' });
});

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <EditorPanelContext.Provider value={contextValue}>{node}</EditorPanelContext.Provider>,
    );
    await Promise.resolve();
  });
  return container;
}

/** Type into the panel's search box, the way the browser does. */
async function search(panel: HTMLDivElement, text: string): Promise<void> {
  const toggle = panel.querySelector<HTMLButtonElement>('button[aria-label^="Search "]');
  await act(async () => {
    toggle?.click();
  });
  const input = panel.querySelector<HTMLInputElement>('input[type="search"]');
  if (input === null) throw new Error('the panel has no search box');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the two library panels (T-V06)', () => {
  it('offers the other panel’s matches when the owner searches', async () => {
    const panel = await render(
      <FiltersPanel canCreate={true} targetLabel="Product" onAddFilter={() => undefined} />,
    );
    await search(panel, 'halftone');

    const also = panel.querySelector('.library-also');
    expect(also?.textContent).toContain('Also in Effects:');
    expect(also?.textContent).toContain('Halftone Press');
    // The item itself is not a filter any more, so it is not in the list.
    expect(panel.querySelector('.filters-grid')?.textContent).not.toContain('Halftone Press');
  });

  it('opens the other panel when the owner follows the link', async () => {
    const panel = await render(
      <FiltersPanel canCreate={true} targetLabel="Product" onAddFilter={() => undefined} />,
    );
    await search(panel, 'halftone');

    const link = panel.querySelector<HTMLButtonElement>('.library-also-link');
    expect(link?.textContent).toBe('Halftone Press');
    await act(async () => {
      link?.click();
    });

    expect(onEnhanceToolChange).toHaveBeenCalledWith('effects');
    expect(librarySearch.get().linkedId).toBe('halftone');
  });

  it('offers the filters when the owner searches in Effects', async () => {
    const panel = await render(
      <EffectsPanel
        project={INITIAL_EDITOR_PROJECT}
        objectId={undefined}
        canApplyEffects={false}
        onDispatch={vi.fn()}
        showToast={vi.fn()}
      />,
    );
    await search(panel, 'gaussian');

    const also = panel.querySelector('.library-also');
    expect(also?.textContent).toContain('Also in Filters:');
    expect(also?.textContent).toContain('Gaussian Blur');
  });

  it('shows a moved item’s favourite in the panel it moved to', async () => {
    // The owner starred Halftone Press while it was still a filter.
    storageMap.set(EFFECT_FAVORITES_KEY, JSON.stringify(['halftone']));
    const panel = await render(
      <EffectsPanel
        project={INITIAL_EDITOR_PROJECT}
        objectId={undefined}
        canApplyEffects={false}
        onDispatch={vi.fn()}
        showToast={vi.fn()}
      />,
    );

    const favorites = panel.querySelector<HTMLButtonElement>('button[aria-label^="Favorites ("]');
    await act(async () => {
      favorites?.click();
    });
    expect(panel.querySelector('.effects-grid')?.textContent).toContain('Halftone Press');
  });

  it('shows a filter’s favourite in the Filters panel', async () => {
    storageMap.set(EFFECT_FAVORITES_KEY, JSON.stringify(['sepia']));
    const panel = await render(
      <FiltersPanel canCreate={true} targetLabel="Product" onAddFilter={() => undefined} />,
    );

    const favorites = panel.querySelector<HTMLButtonElement>(
      'button[data-panel-tab-id="favorites"]',
    );
    await act(async () => {
      favorites?.click();
    });
    expect(panel.querySelector('.filters-grid')?.textContent).toContain('Sepia');
  });

  it('states the rule in one line under each panel’s title', async () => {
    const filters = await render(
      <FiltersPanel canCreate={true} targetLabel="Product" onAddFilter={() => undefined} />,
    );
    expect(filters.querySelector('.library-rule')?.textContent).toMatch(
      /^A Filter changes the look of the picture/u,
    );

    const effects = await render(
      <EffectsPanel
        project={INITIAL_EDITOR_PROJECT}
        objectId={undefined}
        canApplyEffects={false}
        onDispatch={vi.fn()}
        showToast={vi.fn()}
      />,
    );
    expect(effects.querySelector('.library-rule')?.textContent).toMatch(
      /^An Effect changes the picture itself/u,
    );
  });
});
