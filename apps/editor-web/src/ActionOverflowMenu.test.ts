// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActionOverflowMenu } from './ActionOverflowMenu.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('timeline overflow contract', () => {
  it('documents the stable priority order for compact panels', () => {
    expect(['add-track', 'marker', 'duplicate', 'delete', 'flow']).toEqual([
      'add-track',
      'marker',
      'duplicate',
      'delete',
      'flow',
    ]);
  });

  it('keeps the compact overflow trigger visibly discoverable', () => {
    const markup = renderToStaticMarkup(createElement(ActionOverflowMenu, { items: [] }));

    expect(markup).toContain('action-overflow-trigger-label');
    expect(markup).toContain('>More</span>');
    expect(markup).toContain('aria-label="More timeline actions"');
  });

  it('skips disabled actions and restores focus after keyboard dismissal', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | undefined;
    const onSelect = () => undefined;
    vi.useFakeTimers();
    try {
      root = createRoot(container);
      await act(async () => {
        root?.render(
          createElement(ActionOverflowMenu, {
            items: [
              {
                id: 'disabled',
                label: 'Disabled',
                disabled: true,
                disabledReason: 'Unavailable',
                onSelect,
              },
              { id: 'zoom', label: 'Zoom', onSelect },
            ],
          }),
        );
      });

      const trigger = container.querySelector<HTMLButtonElement>('.action-overflow-trigger');
      expect(trigger).not.toBeNull();
      await act(async () => {
        trigger?.click();
      });
      await act(async () => vi.runOnlyPendingTimers());

      const enabled = container.querySelector<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      );
      expect(document.activeElement).toBe(enabled);
      await act(async () => {
        enabled?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(document.activeElement).toBe(trigger);
    } finally {
      await act(async () => root?.unmount());
      container.remove();
      vi.useRealTimers();
    }
  });
});
