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
});
