// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { EffectPreviewMedia } from './EffectPreviewMedia.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('EffectPreviewMedia', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it('renders a draggable before-and-after WebP comparison without a motion video loop', () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(<EffectPreviewMedia effectId="pixelate" />);
    });

    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('input.library-compare-slider')?.getAttribute('type')).toBe(
      'range',
    );
    expect(container.querySelector('img.library-compare-before')?.getAttribute('src')).toMatch(
      /^\/effects\/preview\/before\.webp\?v=/,
    );
    const img = container.querySelector<HTMLImageElement>('img.effect-preview-media-fallback');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toMatch(/^\/effects\/preview\/pixelate\.webp\?v=/);
    expect(img?.getAttribute('width')).toBe('320');
    expect(img?.getAttribute('height')).toBe('240');
  });
});
