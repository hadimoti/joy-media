// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PopupProvider, usePopup, usePopupsClosedWhile } from './popup-manager.js';
import { AppMenuBar } from './AppMenuBar.js';
import { POPUP_IDS, REGISTERED_POPUP_IDS, actionOverflowPopupId } from './popup-ids.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Every popup id the app registers: the static ids, one id per menu-bar group, and one
// panel-header overflow menu (its id is per instance; one instance stands for all).
const ALL_POPUP_IDS: readonly string[] = [
  ...REGISTERED_POPUP_IDS,
  actionOverflowPopupId('panel-sample'),
];

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

// A root that is detached and attached again on every render, as MonitorAspectRatioSelector does.
function InlineRootPopup() {
  const popup = usePopup(POPUP_IDS.canvasFormat);
  return (
    <div ref={(element) => popup.rootRef(element)}>
      <button
        type="button"
        data-trigger={POPUP_IDS.canvasFormat}
        onClick={(event) => popup.toggle(event.currentTarget)}
      >
        inline
      </button>
      {popup.open && (
        <ul role="menu" data-menu={POPUP_IDS.canvasFormat}>
          <li>
            <button type="button" role="menuitem">
              inline item
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

// A toolbar button outside the popup's root, like the command palette's toolbar button.
function ToolbarToggle() {
  const popup = usePopup(POPUP_IDS.commandPalette);
  return (
    <>
      <button
        type="button"
        data-trigger="toolbar"
        aria-haspopup="dialog"
        aria-expanded={popup.open}
        onClick={(event) => popup.toggle(event.currentTarget)}
      >
        Toolbar
      </button>
      {popup.open && (
        <section ref={popup.rootRef} role="dialog" aria-label="Palette" data-menu="palette">
          <input />
        </section>
      )}
    </>
  );
}

function DialogGuard({ open }: { readonly open: boolean }) {
  usePopupsClosedWhile(open);
  return open ? <section role="dialog" aria-modal="true" data-dialog="on" /> : null;
}

function Harness({
  dialogOpen = false,
  omit,
}: {
  readonly dialogOpen?: boolean;
  readonly omit?: string;
}) {
  return (
    <PopupProvider>
      {ALL_POPUP_IDS.filter((id) => id !== omit).map((id) => (
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
  return container?.querySelectorAll('[role="menu"], [data-menu="palette"]').length ?? 0;
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
  const pairs = ALL_POPUP_IDS.flatMap((first) =>
    ALL_POPUP_IDS.filter((second) => second !== first).map((second) => [first, second] as const),
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

    for (const id of [...ALL_POPUP_IDS, ...ALL_POPUP_IDS]) {
      await click(trigger(id));
      expect(openMenuCount()).toBeLessThanOrEqual(1);
    }
  });

  it.each(ALL_POPUP_IDS)(
    '%s closes on its trigger a second time and focus returns to it',
    async (id) => {
      await render(<Harness />);

      await click(trigger(id));
      expect(menu(id)).not.toBeNull();
      await click(trigger(id));
      expect(menu(id)).toBeNull();
      expect(document.activeElement).toBe(trigger(id));
    },
  );

  it.each(ALL_POPUP_IDS)('%s: Escape closes it and returns focus to its trigger', async (id) => {
    await render(<Harness />);

    await click(trigger(id));
    const item = query<HTMLButtonElement>(`[data-item="${id}"]`);
    await act(async () => item.focus());
    await pressKey(item, 'Escape');

    expect(menu(id)).toBeNull();
    expect(document.activeElement).toBe(trigger(id));
  });

  it.each(ALL_POPUP_IDS)(
    '%s: an outside click on plain background closes it and returns focus to its trigger',
    async (id) => {
      await render(<Harness />);

      await click(trigger(id));
      const background = query<HTMLElement>('[data-testid="plain-background"]');
      await pointerDown(background);
      await flushTimers();

      expect(menu(id)).toBeNull();
      expect(document.activeElement).toBe(trigger(id));
    },
  );

  it.each(ALL_POPUP_IDS)(
    '%s: an outside click on another focusable control closes it and keeps that control focused',
    async (id) => {
      await render(<Harness />);

      await click(trigger(id));
      const other = query<HTMLButtonElement>('[data-testid="other-button"]');
      await act(async () => {
        other.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        other.focus();
      });
      await flushTimers();

      expect(menu(id)).toBeNull();
      expect(document.activeElement).toBe(other);
    },
  );

  it.each(ALL_POPUP_IDS)(
    '%s: an outside click into a text field closes it and leaves the text field focused',
    async (id) => {
      await render(<Harness />);

      await click(trigger(id));
      const input = query<HTMLInputElement>('[data-testid="text-input"]');
      await act(async () => {
        input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        input.focus();
      });
      await flushTimers();

      expect(menu(id)).toBeNull();
      expect(document.activeElement).toBe(input);
    },
  );

  it.each(ALL_POPUP_IDS)(
    '%s: choosing an item closes it and returns focus to its trigger',
    async (id) => {
      await render(<Harness />);

      await click(trigger(id));
      await click(query<HTMLButtonElement>(`[data-item="${id}"]`));

      expect(menu(id)).toBeNull();
      expect(document.activeElement).toBe(trigger(id));
    },
  );

  it.each(ALL_POPUP_IDS)('%s: a dialog that opens closes it', async (id) => {
    await render(<Harness />);

    await click(trigger(id));
    expect(menu(id)).not.toBeNull();

    await rerender(<Harness dialogOpen />);

    expect(menu(id)).toBeNull();
    expect(openMenuCount()).toBe(0);
    expect(query('[data-dialog="on"]')).not.toBeNull();
  });

  it('a popup whose root unmounts while open is closed, so it opens again on remount', async () => {
    await render(<Harness />);

    await click(trigger(POPUP_IDS.workspaceSwitcher));
    expect(menu(POPUP_IDS.workspaceSwitcher)).not.toBeNull();

    await rerender(<Harness omit={POPUP_IDS.workspaceSwitcher} />);
    await rerender(<Harness />);

    expect(menu(POPUP_IDS.workspaceSwitcher)).toBeNull();
    expect(trigger(POPUP_IDS.workspaceSwitcher).getAttribute('aria-expanded')).toBe('false');

    await click(trigger(POPUP_IDS.workspaceSwitcher));
    expect(menu(POPUP_IDS.workspaceSwitcher)).not.toBeNull();
  });

  it('a root that detaches and re-attaches on every render keeps its popup open', async () => {
    await render(<InlineRootPopup />);

    await click(trigger(POPUP_IDS.canvasFormat));
    expect(menu(POPUP_IDS.canvasFormat)).not.toBeNull();

    await rerender(<InlineRootPopup />);
    await rerender(<InlineRootPopup />);

    expect(menu(POPUP_IDS.canvasFormat)).not.toBeNull();
  });

  it('a click on the opener of a popup whose root is outside it closes the popup once', async () => {
    await render(<ToolbarToggle />);

    await click(trigger('toolbar'));
    expect(menu('palette')).not.toBeNull();

    // The pointer goes down on the opener first: the popup must stay open for the click.
    await pointerDown(trigger('toolbar'));
    expect(menu('palette')).not.toBeNull();

    await click(trigger('toolbar'));
    expect(menu('palette')).toBeNull();
    expect(document.activeElement).toBe(trigger('toolbar'));

    await click(trigger('toolbar'));
    expect(menu('palette')).not.toBeNull();
  });
});

// Reads the component sources: every popup id a component passes to the manager must be
// in the registry. Calls through `usePopup`, `openPopup`, `closePopup` and `togglePopup`
// must use a listed literal or a registry reference.
const REGISTRY_REFERENCE = /^(POPUP_IDS\.\w+|appMenuPopupId\(|actionOverflowPopupId\()/;
const POPUP_CALL = /\b(?:usePopup|openPopup|closePopup|togglePopup)\(\s*/g;

function scanPopupCalls(source: string): { calls: number; problems: string[] } {
  const problems: string[] = [];
  let calls = 0;
  for (const match of source.matchAll(POPUP_CALL)) {
    calls += 1;
    const rest = source.slice((match.index ?? 0) + match[0].length);
    const quote = rest[0];
    if (quote === "'" || quote === '"' || quote === '`') {
      const end = rest.indexOf(quote, 1);
      const literal = end === -1 ? rest.slice(1) : rest.slice(1, end);
      if (literal.includes('${') || !REGISTERED_POPUP_IDS.includes(literal)) problems.push(literal);
    } else if (!REGISTRY_REFERENCE.test(rest)) {
      problems.push(rest.slice(0, 40));
    }
  }
  return { calls, problems };
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const isComponent =
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.|\.d\.ts$/.test(entry.name) &&
      entry.name !== 'popup-manager.tsx';
    return isComponent ? [path] : [];
  });
}

describe('popup registry', () => {
  const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));

  it('lists every popup id a component registers', () => {
    let calls = 0;
    const problems: string[] = [];
    for (const file of sourceFiles(SOURCE_DIR)) {
      const scan = scanPopupCalls(readFileSync(file, 'utf8'));
      calls += scan.calls;
      problems.push(...scan.problems.map((problem) => `${relative(SOURCE_DIR, file)}: ${problem}`));
    }

    expect(problems).toEqual([]);
    // Guards against the scan matching nothing at all.
    expect(calls).toBeGreaterThan(10);
  });

  it('reports a popup id that a component registers without listing it', () => {
    expect(scanPopupCalls("usePopup('rogue-popup')").problems).toEqual(['rogue-popup']);
    expect(scanPopupCalls('closePopup(`action-overflow:${key}`)').problems).toHaveLength(1);
    expect(scanPopupCalls('openPopup(makeId())').problems).toHaveLength(1);
    expect(scanPopupCalls('usePopup(POPUP_IDS.commandPalette)').problems).toEqual([]);
    expect(scanPopupCalls("togglePopup('command-palette')").problems).toEqual([]);
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
