// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PopupProvider, usePopup, usePopupsClosedWhile } from './popup-manager.js';
import { AppMenuBar } from './AppMenuBar.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const POPUP_IDS = ['export-preset', 'workspace', 'recent-processes', 'canvas-format'] as const;

function PopupButton({ id }: { readonly id: string }) {
  const popup = usePopup(id);
  return (
    <div ref={popup.rootRef}>
      <button
        type="button"
        data-trigger={id}
        aria-haspopup="menu"
        aria-expanded={popup.open}
        onClick={(event) => popup.toggle(event.currentTarget)}
      >
        {id}
      </button>
      {popup.open && (
        <ul role="menu" data-menu={id}>
          <li>
            <button type="button" role="menuitem" data-item={id} onClick={() => popup.close()}>
              Item {id}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

function DialogGuard({ open }: { readonly open: boolean }) {
  usePopupsClosedWhile(open);
  return open ? <section role="dialog" aria-modal="true" data-dialog="on" /> : null;
}

function Harness({ dialogOpen = false }: { readonly dialogOpen?: boolean }) {
  return (
    <PopupProvider>
      {POPUP_IDS.map((id) => (
        <PopupButton key={id} id={id} />
      ))}
      <button type="button" data-testid="other-button">
        Other button
      </button>
      <input data-testid="text-input" />
      <p data-testid="plain-background">Background</p>
      <DialogGuard open={dialogOpen} />
    </PopupProvider>
  );
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function render(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
}

async function rerender(element: React.ReactElement) {
  await act(async () => root?.render(element));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function query<T extends Element>(selector: string): T {
  const found = container?.querySelector<T>(selector);
  if (found === null || found === undefined) throw new Error(`missing ${selector}`);
  return found;
}

function trigger(id: string): HTMLButtonElement {
  return query<HTMLButtonElement>(`[data-trigger="${id}"]`);
}

function menu(id: string): Element | null {
  return container?.querySelector(`[data-menu="${id}"]`) ?? null;
}

function openMenuCount(): number {
  return container?.querySelectorAll('[role="menu"]').length ?? 0;
}

// A real click sends pointerdown (which closes other popups) before focus and click.
async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    element.focus();
    element.click();
  });
}

async function pointerDown(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
}

async function pressKey(element: HTMLElement, key: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

async function flushTimers() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('one popup open at a time', () => {
  const pairs = POPUP_IDS.flatMap((first) =>
    POPUP_IDS.filter((second) => second !== first).map((second) => [first, second] as const),
  );

  it.each(pairs)('opening %s then %s closes %s', async (first, second) => {
    await render(<Harness />);

    await click(trigger(first));
    expect(menu(first)).not.toBeNull();

    await click(trigger(second));
    expect(menu(first)).toBeNull();
    expect(menu(second)).not.toBeNull();
    expect(trigger(first).getAttribute('aria-expanded')).toBe('false');
    expect(trigger(second).getAttribute('aria-expanded')).toBe('true');
    expect(openMenuCount()).toBe(1);
  });

  it('never has two popups open after a run through every trigger', async () => {
    await render(<Harness />);

    for (const id of [...POPUP_IDS, ...POPUP_IDS]) {
      await click(trigger(id));
      expect(openMenuCount()).toBeLessThanOrEqual(1);
    }
  });

  it('closes on the trigger a second time', async () => {
    await render(<Harness />);

    await click(trigger('workspace'));
    expect(menu('workspace')).not.toBeNull();
    await click(trigger('workspace'));
    expect(menu('workspace')).toBeNull();
    expect(document.activeElement).toBe(trigger('workspace'));
  });

  it('Escape closes the open popup and returns focus to its trigger', async () => {
    await render(<Harness />);

    await click(trigger('export-preset'));
    const item = query<HTMLButtonElement>('[data-item="export-preset"]');
    await act(async () => item.focus());
    await pressKey(item, 'Escape');

    expect(menu('export-preset')).toBeNull();
    expect(document.activeElement).toBe(trigger('export-preset'));
  });

  it('an outside click on plain background closes the popup and returns focus to its trigger', async () => {
    await render(<Harness />);

    await click(trigger('recent-processes'));
    const background = query<HTMLElement>('[data-testid="plain-background"]');
    await pointerDown(background);
    await flushTimers();

    expect(menu('recent-processes')).toBeNull();
    expect(document.activeElement).toBe(trigger('recent-processes'));
  });

  it('an outside click on another focusable control closes the popup and keeps that control focused', async () => {
    await render(<Harness />);

    await click(trigger('canvas-format'));
    const other = query<HTMLButtonElement>('[data-testid="other-button"]');
    await act(async () => {
      other.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      other.focus();
    });
    await flushTimers();

    expect(menu('canvas-format')).toBeNull();
    expect(document.activeElement).toBe(other);
  });

  it('an outside click into a text field closes the popup and leaves the text field focused', async () => {
    await render(<Harness />);

    await click(trigger('workspace'));
    const input = query<HTMLInputElement>('[data-testid="text-input"]');
    await act(async () => {
      input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      input.focus();
    });
    await flushTimers();

    expect(menu('workspace')).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('choosing an item closes the popup and returns focus to its trigger', async () => {
    await render(<Harness />);

    await click(trigger('workspace'));
    await click(query<HTMLButtonElement>('[data-item="workspace"]'));

    expect(menu('workspace')).toBeNull();
    expect(document.activeElement).toBe(trigger('workspace'));
  });

  it('a dialog that opens closes every popup', async () => {
    await render(<Harness />);

    await click(trigger('export-preset'));
    expect(openMenuCount()).toBe(1);

    await rerender(<Harness dialogOpen />);

    expect(openMenuCount()).toBe(0);
    expect(query('[data-dialog="on"]')).not.toBeNull();
  });
});

describe('app menu bar on the popup manager', () => {
  const props = {
    canUndo: true,
    canRedo: true,
    hasSelection: true,
    exporting: false,
    onAction: vi.fn(),
  };

  function menubarTrigger(label: string): HTMLButtonElement {
    const found = [
      ...(container?.querySelectorAll<HTMLButtonElement>('.app-menu-trigger') ?? []),
    ].find((button) => button.textContent === label);
    if (found === undefined) throw new Error(`missing menu ${label}`);
    return found;
  }

  it('hovering another menu moves the open menu and Escape returns focus to the menu that is open', async () => {
    await render(
      <PopupProvider>
        <AppMenuBar {...props} />
      </PopupProvider>,
    );

    await click(menubarTrigger('File'));
    expect(container?.querySelectorAll('[role="menu"]').length).toBe(1);
    expect(menubarTrigger('File').getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      menubarTrigger('Edit').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(menubarTrigger('File').getAttribute('aria-expanded')).toBe('false');
    expect(menubarTrigger('Edit').getAttribute('aria-expanded')).toBe('true');
    expect(container?.querySelectorAll('[role="menu"]').length).toBe(1);

    const editItem = container?.querySelector<HTMLButtonElement>('[role="menu"] [role="menuitem"]');
    if (editItem === null || editItem === undefined) throw new Error('missing menu item');
    await act(async () => editItem.focus());
    await pressKey(editItem, 'Escape');

    expect(container?.querySelectorAll('[role="menu"]').length).toBe(0);
    expect(document.activeElement).toBe(menubarTrigger('Edit'));
  });
});
