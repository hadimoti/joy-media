// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TransitionShaderEntry } from '@joy-media/transition-shaders';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRY: TransitionShaderEntry = {
  id: 'dissolve',
  glName: 'dissolve',
  label: 'Dissolve',
  license: 'MIT',
  author: 'JOY',
  glsl: '',
  defaultParams: {},
  paramsTypes: {},
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let imageShouldFail = false;

beforeEach(() => {
  vi.resetModules();
  imageShouldFail = false;
  vi.stubGlobal(
    'Image',
    class MockImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => {
          if (imageShouldFail) this.onerror?.();
          else this.onload?.();
        });
      }
    },
  );
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const context = {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    (() => context) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
});

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TransitionPreviewCard', () => {
  it('announces a loaded preview and starts animation', async () => {
    await renderPreview();

    const canvas = container?.querySelector('canvas');
    expect(canvas?.getAttribute('aria-label')).toBe('Dissolve transition preview');
    expect(canvas?.getAttribute('aria-busy')).toBe('false');
    expect(canvas?.style.opacity).toBe('1');
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
  });

  it('offers an announced retry when source frames fail to load', async () => {
    imageShouldFail = true;
    const parentClick = vi.fn();
    await renderPreview(parentClick);

    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      'Preview unavailable.',
    );
    const retry = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Retry Dissolve transition preview"]',
    );
    expect(retry).not.toBeNull();

    imageShouldFail = false;
    await act(async () => {
      retry?.click();
      await settleImages();
    });

    expect(parentClick).not.toHaveBeenCalled();
    expect(container?.querySelector('[role="alert"]')).toBeNull();
    expect(container?.querySelector('canvas')?.style.opacity).toBe('1');
  });
});

async function renderPreview(parentClick?: () => void): Promise<void> {
  const { TransitionPreviewCard } = await import('./TransitionPreviewCard.js');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <div onClick={parentClick}>
        <TransitionPreviewCard entry={ENTRY} isActive />
      </div>,
    );
    await settleImages();
  });
}

async function settleImages(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
