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
  const initialVisibilityState = document.visibilityState;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: initialVisibilityState,
    });
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
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
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

  it('bounds mounted and playing previews when a catalog has many effects', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.stubGlobal('matchMedia', () => mediaQueryList(false));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <>
          {Array.from({ length: 20 }, (_, index) => (
            <EffectPreviewMedia key={index} effectId={`effect-${index}`} />
          ))}
        </>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const mounted = container.querySelectorAll('[data-preview-mounted="true"]');
    const videos = container.querySelectorAll('video.effect-preview-media-video');
    expect(mounted).toHaveLength(12);
    expect(videos).toHaveLength(6);
    expect(container.querySelectorAll('video, img')).toHaveLength(12);
    expect(container.querySelectorAll('[data-preview-mounted="false"]')).toHaveLength(8);
  });

  it('offers an accessible retry after a motion preview fails', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('decode failed'));
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    render();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const retry = container?.querySelector<HTMLButtonElement>('.effect-preview-media-retry');
    expect(retry?.getAttribute('aria-label')).toBe('Retry motion preview');
    expect(container?.querySelector('img.effect-preview-media-fallback')).not.toBeNull();
  });
});
