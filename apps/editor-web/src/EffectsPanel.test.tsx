// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';

vi.mock('@joy-media/visual-effects', () => {
  let ready = false;
  const descriptor = {
    id: 'pixelate',
    label: 'Pixelate',
    category: 'stylize',
    description: 'Pixel preview',
    params: [],
    tags: ['pixel'],
    backend: { pixiPreview: true, headless: true, ffmpeg: true, deterministic: true },
    cost: 'low',
  };
  return {
    effectRegistry: { getEffect: () => descriptor },
    listEffects: () => (ready ? [descriptor] : []),
    registerBuiltins: () => {
      ready = true;
    },
  };
});

vi.mock('./App.js', async () => {
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

describe('EffectsPanel', () => {
  it('shows the default built-in catalog and real category counts after registration', async () => {
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
        />,
      );
      await Promise.resolve();
    });

    const pixelTab = container.querySelector<HTMLButtonElement>(
      'button.effects-panel-category-tab[aria-selected="true"]',
    );
    expect(pixelTab?.getAttribute('aria-label')).toMatch(/^Pixel \/ B&W \([1-9]\d*\)$/);
    expect(container.textContent).toContain('Pixelate');
    expect(container.textContent).not.toContain('No effects match your search.');
  });

  it('adds the focused effect card with Enter or Space', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const onDispatch = vi.fn();

    await act(async () => {
      root?.render(
        <EffectsPanel
          project={INITIAL_EDITOR_PROJECT}
          objectId="intro-title"
          canApplyEffects={true}
          onDispatch={onDispatch}
          showToast={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    const card = container.querySelector<HTMLElement>('.effect-card');
    expect(card?.getAttribute('role')).toBe('group');
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
        effectId: 'pixelate',
        params: {},
      },
    });
  });

  it('exposes why an effect is unavailable instead of silently disabling it', async () => {
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
        />,
      );
      await Promise.resolve();
    });

    const card = container.querySelector<HTMLElement>('.effect-card');
    const reasonId = card?.getAttribute('aria-describedby');
    expect(card?.getAttribute('aria-disabled')).toBeNull();
    expect(reasonId).toBeTruthy();
    expect(container.querySelector(`#${reasonId}`)?.textContent).toContain('Select a video clip');
  });

  it('does not fall back to raw browser storage when no writer-gated context exists', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const showToast = vi.fn();

    await act(async () => {
      root?.render(
        <EffectsPanel
          project={INITIAL_EDITOR_PROJECT}
          objectId={undefined}
          canApplyEffects={false}
          onDispatch={vi.fn()}
          showToast={showToast}
        />,
      );
      await Promise.resolve();
    });

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
