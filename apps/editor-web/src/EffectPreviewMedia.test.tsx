// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EffectPreviewMedia } from './EffectPreviewMedia.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function mediaQueryList(matches: boolean): MediaQueryList {
  return {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  } as unknown as MediaQueryList;
}

describe('EffectPreviewMedia', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function render(matchesReducedMotion = false): void {
    vi.stubGlobal('matchMedia', () => mediaQueryList(matchesReducedMotion));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(<EffectPreviewMedia effectId="pixelate" />);
    });
  }

  it('uses the deterministic poster when reduced motion is requested', async () => {
    render(true);
    await act(async () => {
      await Promise.resolve();
    });

    expect(container?.querySelector('video')).toBeNull();
    expect(container?.querySelector('img.effect-preview-media-fallback')).not.toBeNull();
  });

  it('falls back to the poster when autoplay is rejected', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('autoplay denied'));
    render();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.querySelector('video')).toBeNull();
    expect(container?.querySelector('img.effect-preview-media-fallback')).not.toBeNull();
  });

  it('uses the poster while the document is hidden', async () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(container?.querySelector('video')).toBeNull();
    expect(container?.querySelector('img.effect-preview-media-fallback')).not.toBeNull();
  });
});
