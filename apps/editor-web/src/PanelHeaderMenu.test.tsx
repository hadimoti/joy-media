// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DockviewApi,
  DockviewGroupPanel,
  IDockviewHeaderActionsProps,
  IDockviewPanel,
} from 'dockview';
import { PopupProvider } from './popup-manager.js';
import { EditorPanelContext } from './editor-panel-context.js';
import { PanelHeaderActions, PanelHeaderMenu } from './PanelHeaderMenu.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface MenuRig {
  readonly host: HTMLDivElement;
  readonly sourceGroup: DockviewGroupPanel;
  readonly destinationGroup: DockviewGroupPanel;
  readonly containerApi: DockviewApi;
  readonly activePanel: IDockviewPanel;
  readonly closePanel: ReturnType<typeof vi.fn>;
  readonly addFloatingGroup: ReturnType<typeof vi.fn>;
  readonly moveTo: ReturnType<typeof vi.fn>;
  readonly maximize: ReturnType<typeof vi.fn>;
  readonly exitMaximized: ReturnType<typeof vi.fn>;
  readonly resetLayout: ReturnType<typeof vi.fn>;
  readonly root: Root;
  readonly trigger: HTMLButtonElement;
}

let rig: MenuRig | undefined;

afterEach(async () => {
  if (rig !== undefined) {
    await act(async () => rig?.root.unmount());
    rig.host.remove();
    rig = undefined;
  }
  vi.useRealTimers();
});

async function mountMenu(
  options: {
    readonly location?: 'grid' | 'floating';
    readonly maximized?: boolean;
    readonly hasDestination?: boolean;
    readonly throughPanelContext?: boolean;
  } = {},
): Promise<MenuRig> {
  const closePanel = vi.fn();
  const addFloatingGroup = vi.fn();
  const moveTo = vi.fn();
  const maximize = vi.fn();
  const exitMaximized = vi.fn();
  const resetLayout = vi.fn();
  const sourceApi = {
    location: { type: options.location ?? 'grid' },
    isMaximized: vi.fn(() => options.maximized ?? false),
    moveTo,
    maximize,
    exitMaximized,
  };
  const sourceGroup = { id: 'context', api: sourceApi } as unknown as DockviewGroupPanel;
  const destinationGroup = {
    id: 'browser',
    activePanel: { title: 'Media' },
    api: { location: { type: 'grid' } },
  } as unknown as DockviewGroupPanel;
  const containerApi = {
    groups: options.hasDestination === false ? [sourceGroup] : [sourceGroup, destinationGroup],
    addFloatingGroup,
  } as unknown as DockviewApi;
  const activePanel = {
    id: 'inspector',
    title: 'Inspector',
    api: { close: closePanel },
  } as unknown as IDockviewPanel;
  const props = {
    api: sourceApi,
    containerApi,
    panels: [activePanel],
    activePanel,
    isGroupActive: true,
    group: sourceGroup,
  } as unknown as IDockviewHeaderActionsProps;

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  vi.useFakeTimers();
  await act(async () => {
    const menu = options.throughPanelContext
      ? createElement(
          EditorPanelContext.Provider,
          { value: { resetWorkspace: resetLayout } as never },
          createElement(PanelHeaderActions, props),
        )
      : createElement(PanelHeaderMenu, { ...props, onResetLayout: resetLayout });
    root.render(createElement(PopupProvider, null, menu));
  });
  const trigger = host.querySelector<HTMLButtonElement>(
    '[aria-label="More actions for Inspector"]',
  );
  expect(trigger, 'the group header has a panel-actions trigger').not.toBeNull();

  const nextRig = {
    host,
    sourceGroup,
    destinationGroup,
    containerApi,
    activePanel,
    closePanel,
    addFloatingGroup,
    moveTo,
    maximize,
    exitMaximized,
    resetLayout,
    root,
    trigger: trigger!,
  };
  rig = nextRig;
  return nextRig;
}

async function openMenu(current: MenuRig): Promise<HTMLButtonElement[]> {
  await act(async () => current.trigger.click());
  await act(async () => vi.runOnlyPendingTimers());
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
}

function itemLabel(item: HTMLButtonElement): string {
  return item.querySelector('span')?.textContent?.trim() ?? item.textContent?.trim() ?? '';
}

async function select(items: readonly HTMLButtonElement[], label: string): Promise<void> {
  const item = items.find((candidate) => itemLabel(candidate) === label);
  expect(item, `menu item ${label}`).toBeTruthy();
  await act(async () => item?.click());
}

describe('Dockview panel header menu', () => {
  it('names the action trigger for the active panel', async () => {
    const current = await mountMenu();

    expect(current.trigger.getAttribute('aria-label')).toBe('More actions for Inspector');
  });

  it('runs only Dockview-supported group actions and the workspace reset', async () => {
    const current = await mountMenu();
    let items = await openMenu(current);

    expect(items.map((item) => item.textContent?.trim())).toEqual([
      'Close panel',
      'Float group',
      'Maximize panel',
      'Move group to left of Media',
      'Move group to right of Media',
      'Move group to bottom of Media',
      'Reset workspace',
    ]);
    expect(items.find((item) => itemLabel(item) === 'Float group')?.title).toBe(
      'Moves the whole panel group into a floating window.',
    );
    expect(items.find((item) => itemLabel(item) === 'Reset workspace')?.title).toBe(
      'Clears every saved panel layout for all workspaces, plus saved view settings. Your projects and media are not touched.',
    );
    await select(items, 'Close panel');
    expect(current.closePanel).toHaveBeenCalledOnce();

    items = await openMenu(current);
    await select(items, 'Float group');
    expect(current.addFloatingGroup).toHaveBeenCalledWith(current.sourceGroup);

    items = await openMenu(current);
    await select(items, 'Maximize panel');
    expect(current.maximize).toHaveBeenCalledOnce();

    for (const [label, position] of [
      ['Move group to left of Media', 'left'],
      ['Move group to right of Media', 'right'],
      ['Move group to bottom of Media', 'bottom'],
    ] as const) {
      items = await openMenu(current);
      await select(items, label);
      expect(current.moveTo).toHaveBeenCalledWith({
        group: current.destinationGroup,
        position,
      });
    }

    items = await openMenu(current);
    await select(items, 'Reset workspace');
    expect(current.resetLayout).toHaveBeenCalledOnce();
  });

  it('offers Restore for a maximized group', async () => {
    const current = await mountMenu({ maximized: true });
    const items = await openMenu(current);

    const restore = items.find((item) => itemLabel(item) === 'Restore panel');
    expect(restore, 'a maximized group offers Restore').toBeTruthy();
    expect(restore?.disabled).toBe(false);
    await select(items, 'Restore panel');
    expect(current.exitMaximized).toHaveBeenCalledOnce();
  });

  it('routes the panel reset action through the workspace context', async () => {
    const current = await mountMenu({ throughPanelContext: true });
    const items = await openMenu(current);

    await select(items, 'Reset workspace');
    expect(current.resetLayout).toHaveBeenCalledOnce();
  });

  it('stacks the popover above the Dockview overlay band it is portaled over', () => {
    // jsdom's URL is not a file URL, so build the path from this module's file location.
    const appCss = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'app.css'),
      'utf8',
    );
    const rule = /\.action-overflow-popover\s*\{[^}]*?z-index:\s*(\d+);/.exec(appCss);

    expect(rule, 'the popover rule sets a z-index').toBeTruthy();
    // Dockview's overlay variable defaults to 999 and floating groups stack above it.
    expect(Number(rule?.[1])).toBeGreaterThan(999);
  });

  it('disables actions the current group cannot perform', async () => {
    const current = await mountMenu({ location: 'floating', hasDestination: false });
    const items = await openMenu(current);

    expect(items.find((item) => itemLabel(item) === 'Float group')?.disabled).toBe(true);
    expect(
      items.find((item) => itemLabel(item) === 'Move group to left of another group')?.disabled,
    ).toBe(true);
    expect(items.find((item) => itemLabel(item) === 'Maximize panel')?.disabled).toBe(true);
  });
});
