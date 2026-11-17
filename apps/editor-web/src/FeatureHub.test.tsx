// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatureHub } from './FeatureHub.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('FeatureHub narrow tabs', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let clientWidthDescriptor: PropertyDescriptor | undefined;
  let scrollWidthDescriptor: PropertyDescriptor | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    if (clientWidthDescriptor === undefined)
      Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
    else Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidthDescriptor);
    if (scrollWidthDescriptor === undefined)
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
    else Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scrollWidthDescriptor);
    vi.unstubAllGlobals();
  });

  it('switches to icon tabs in a narrow nav and keeps the selected tab present', async () => {
    class ResizeObserverStub {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    clientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    scrollWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return this.classList.contains('feature-hub-nav') ? 150 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get() {
        return this.getAttribute('role') === 'tab' ? 60 : 0;
      },
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <FeatureHub hub="enhance" activeTool="adjust" onToolChange={() => undefined}>
          <div />
        </FeatureHub>,
      );
    });

    const nav = container.querySelector<HTMLElement>('.feature-hub-nav');
    expect(nav?.classList.contains('is-compact')).toBe(true);
    const selected = nav?.querySelector<HTMLElement>(
      '[role="tab"][data-feature-tool="adjust"][aria-selected="true"]',
    );
    expect(selected).not.toBeNull();
    expect(selected?.getAttribute('aria-label')).toBe('Adjustment Layers');
    expect(selected?.getAttribute('title')).toBe('Adjustment Layers');
    expect(nav?.querySelectorAll('[role="tab"][data-feature-tool]')).toHaveLength(6);
  });
});
