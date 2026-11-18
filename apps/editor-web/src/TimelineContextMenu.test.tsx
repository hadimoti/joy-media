// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { TimelineContextMenu } from './TimelineContextMenu.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('TimelineContextMenu', () => {
  it('renders timeline actions in the anchored context drawer with their shortcuts', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TimelineContextMenu
          menu={{
            x: 240,
            y: 180,
            items: [
              { label: 'Split at playhead', shortcut: 'S', action: () => undefined },
              { label: '', action: () => undefined, dividerBefore: true },
              { label: 'Ripple delete', shortcut: 'Delete', action: () => undefined },
            ],
          }}
          onClose={() => undefined}
        />,
      );
    });
    const markup = document.body.innerHTML;
    expect(markup).toContain('timeline-context-menu');
    expect(markup).toContain('timeline-context-backdrop');
    expect(markup).toContain('Split at playhead');
    expect(markup).toContain('Ripple delete');
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('data-menu-index="2"');
    // A divider entry draws only its line: no empty row, so the drawer stays short.
    expect(markup.match(/role="menuitem"/g)).toHaveLength(2);
  });

  it('is drawn on the page body, not inside the timeline panel that would clip it', async () => {
    container = document.createElement('div');
    container.className = 'timeline-panel';
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TimelineContextMenu
          menu={{ x: 10, y: 10, items: [{ label: 'Duplicate', action: () => undefined }] }}
          onClose={() => undefined}
        />,
      );
    });
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(container.contains(menu)).toBe(false);
    expect(menu?.parentElement).toBe(document.body);
  });

  it('runs the focused action when Enter is pressed', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    let calls = 0;
    await act(async () => {
      root?.render(
        <TimelineContextMenu
          menu={{ x: 20, y: 20, items: [{ label: 'Fit to frame', action: () => calls++ }] }}
          onClose={() => undefined}
        />,
      );
    });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(calls).toBe(1);
  });
});
