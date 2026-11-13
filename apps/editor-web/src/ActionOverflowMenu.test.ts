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

  it('keeps a left-edge menu in the viewport and restores focus after keyboard dismissal', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | undefined;
    const onSelect = () => undefined;
    const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('action-overflow-popover')) {
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 220,
          bottom: 100,
          width: 220,
          height: 100,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return originalGetBoundingClientRect.call(this);
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 180 });
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
      trigger!.getBoundingClientRect = () =>
        ({
          x: 50,
          y: 40,
          left: 50,
          top: 40,
          right: 90,
          bottom: 64,
          width: 40,
          height: 24,
          toJSON: () => ({}),
        }) as DOMRect;
      await act(async () => {
        trigger?.click();
      });
      await act(async () => vi.runOnlyPendingTimers());

      const popover = document.body.querySelector<HTMLElement>('.action-overflow-popover');
      expect(popover?.parentElement, 'the menu is outside the clipped group header').toBe(
        document.body,
      );
      expect(popover?.style.position).toBe('fixed');
      expect(popover?.style.top).toBe('68px');
      expect(popover?.style.left).toBe('8px');
      expect(popover?.style.boxSizing).toBe('border-box');
      expect(popover?.style.maxWidth).toBe('164px');

      const enabled = document.body.querySelector<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      );
      expect(document.activeElement).toBe(enabled);
      await act(async () => {
        enabled?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      });
      expect(document.body.querySelector('[role="menu"]')).toBe(popover);
      await act(async () => {
        enabled?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(document.activeElement).toBe(trigger);
    } finally {
      await act(async () => root?.unmount());
      container.remove();
      vi.useRealTimers();
      vi.restoreAllMocks();
      if (originalInnerWidth !== undefined) {
        Object.defineProperty(window, 'innerWidth', originalInnerWidth);
      }
    }
  });

  it('selects an item inside the portal without dismissing it as an outside click', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | undefined;
    const onSelect = vi.fn();
    vi.useFakeTimers();
    try {
      root = createRoot(container);
      await act(async () => {
        root?.render(
          createElement(ActionOverflowMenu, { items: [{ id: 'open', label: 'Open', onSelect }] }),
        );
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.action-overflow-trigger')?.click();
      });
      await act(async () => vi.runOnlyPendingTimers());

      const item = document.body.querySelector<HTMLButtonElement>('[role="menuitem"]');
      await act(async () => {
        item?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      });
      await act(async () => item?.click());

      expect(onSelect).toHaveBeenCalledOnce();
      expect(document.body.querySelector('[role="menu"]')).toBeNull();
    } finally {
      await act(async () => root?.unmount());
      container.remove();
      vi.useRealTimers();
    }
  });
});
