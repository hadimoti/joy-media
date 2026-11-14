// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';

vi.mock('@joy-media/visual-effects', () => {
  let ready = false;
  const descriptor = (id: string, label: string, category: string, tags: readonly string[]) => ({
    id,
    label,
    category,
    description: 'Pixel preview',
    params: [],
    tags,
    backend: { pixiPreview: true, headless: true, ffmpeg: true, deterministic: true },
    cost: 'low',
  });
  // `pixelate` is a Filter now (T-V06): the Effects panel must not show it.
  const descriptors = new Map<string, ReturnType<typeof descriptor>>([
    ['curves', descriptor('curves', 'Curves', 'color', ['color', 'curves'])],
    ['bulge', descriptor('bulge', 'Bulge / Pinch', 'distort', ['distort', 'bulge'])],
    ['pixelate', descriptor('pixelate', 'Pixelate', 'stylize', ['stylize', 'pixelate'])],
  ]);
  return {
    effectRegistry: { getEffect: (id: string) => descriptors.get(id) },
    listEffects: () => (ready ? [...descriptors.values()] : []),
    registerBuiltins: () => {
      ready = true;
    },
  };
});

vi.mock('./editor-panel-context.js', async () => {
  const { createContext } = await import('react');
  return { EditorPanelContext: createContext(undefined) };
});

vi.mock('./EffectPreviewMedia.js', () => ({
  EffectPreviewMedia: ({ effectId }: { readonly effectId: string }) => (
    <div data-effect-preview={effectId} />
  ),
}));

import { EffectsPanel } from './EffectsPanel.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  if (root !== undefined) {
    await act(async () => root?.unmount());
  }
  container?.remove();
  root = undefined;
  container = undefined;
  window.localStorage.clear();
  vi.restoreAllMocks();
});

async function mountPanel(
  props: Partial<React.ComponentProps<typeof EffectsPanel>> = {},
): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(
      <EffectsPanel
        project={INITIAL_EDITOR_PROJECT}
        objectId={undefined}
        canApplyEffects={false}
        onDispatch={vi.fn()}
        showToast={vi.fn()}
        {...props}
      />,
    );
    await Promise.resolve();
  });
  return container;
}

describe('EffectsPanel', () => {
  it('shows the default built-in catalog and real category counts after registration', async () => {
    await mountPanel();

    const selected = container!.querySelector<HTMLButtonElement>(
      'button.library-rail-item[aria-selected="true"]',
    );
    expect(selected?.getAttribute('aria-label')).toMatch(/^Colour & Light \([1-9]\d*\)$/);
    expect(container!.textContent).toContain('Curves');
    expect(container!.textContent).not.toContain('No effects match your search.');
  });

  it('shows no explanation text under the title', async () => {
    await mountPanel();
    expect(container!.querySelector('.library-rule')).toBeNull();
    expect(container!.textContent).not.toContain('An Effect changes');
  });

  it('shows an item that lives in Filters nowhere in the panel', async () => {
    await mountPanel();
    // Pixelate is a Filter (T-V06): it is not in any Effects category.
    expect(container!.textContent).not.toContain('Pixelate');
  });

  it('shows each effect once, with no second group of the same items', async () => {
    await mountPanel();
    const categories = [...container!.querySelectorAll('.library-rail-item')].map((tab) =>
      tab.getAttribute('aria-label')?.replace(/ \(\d+\)$/u, ''),
    );
    expect(categories.join(' ')).not.toContain('Pixel / B&W');
    expect(categories).toEqual([
      'Recipes',
      'Favorites',
      'Colour & Light',
      'Depth & Shadow',
      'Distort & Move',
      'Drawn & Printed',
      'Edge & Detail',
      'Retro & Screen',
    ]);
  });

  it('adds the focused effect card with Enter or Space', async () => {
    const onDispatch = vi.fn();
    await mountPanel({ objectId: 'intro-title', canApplyEffects: true, onDispatch });

    const card = container!.querySelector<HTMLElement>('.effect-card');
    // Named by its visible title; no redundant "library card" group label.
    expect(card?.getAttribute('role')).toBeNull();
    expect(card?.getAttribute('aria-label')).toBeNull();
    expect(document.getElementById(card?.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      card?.querySelector('.library-card-name')?.textContent,
    );
    expect(card?.getAttribute('aria-keyshortcuts')).toBe('Enter Space');
    await act(async () => {
      card?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      card?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(onDispatch).toHaveBeenCalledTimes(2);
    expect(onDispatch).toHaveBeenCalledWith({
      type: 'effect.add',
      payload: {
        objectId: 'intro-title',
        effectId: 'curves',
        params: {},
      },
    });
  });

  it('exposes why an effect is unavailable instead of silently disabling it', async () => {
    await mountPanel();

    const card = container!.querySelector<HTMLElement>('.effect-card');
    const reasonId = card?.getAttribute('aria-describedby');
    expect(card?.getAttribute('aria-disabled')).toBeNull();
    expect(reasonId).toBeTruthy();
    expect(container!.querySelector(`#${reasonId}`)?.textContent).toContain('Select a video clip');
  });

  it('does not fall back to raw browser storage when no writer-gated context exists', async () => {
    const showToast = vi.fn();
    await mountPanel({ showToast });

    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('button[aria-label="Create effect recipe"]')
        ?.click();
    });

    expect(showToast).toHaveBeenCalledWith(
      'Effect recipes require an active editor session.',
      'error',
    );
    expect(window.localStorage.length).toBe(0);
  });
});
