// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { lazy } from 'react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { LazyPanel } from './LazyPanel.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: ReturnType<typeof createRoot>[] = [];

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('LazyPanel', () => {
  it('shows a stable loading state, then mounts the panel once its chunk resolves', async () => {
    let resolveChunk: ((module: { default: () => ReactElement }) => void) | undefined;
    const LazyChild = lazy(
      () =>
        new Promise<{ default: () => ReactElement }>((resolve) => {
          resolveChunk = resolve;
        }),
    );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);

    await act(async () => {
      root.render(
        <LazyPanel label="Deferred panel">
          <LazyChild />
        </LazyPanel>,
      );
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Loading Deferred panel',
    );

    await act(async () => {
      resolveChunk?.({ default: () => <div data-testid="mounted-panel">Ready</div> });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="mounted-panel"]')?.textContent).toBe('Ready');
  });
});
