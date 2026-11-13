// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DockviewApi,
  DockviewGroupPanel,
  IDockviewHeaderActionsProps,
  IDockviewPanel,
} from 'dockview';
import { PopupProvider } from './popup-manager.js';
import { PanelHeaderMenu } from './PanelHeaderMenu.js';

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
    root.render(
      createElement(
        PopupProvider,
        null,
        createElement(PanelHeaderMenu, { ...props, onResetLayout: resetLayout }),
      ),
    );
  });
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="More panel actions"]');
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
  return Array.from(current.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
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
  it('runs only Dockview-supported group actions and the app layout reset', async () => {
    const current = await mountMenu();
    let items = await openMenu(current);

    expect(items.map((item) => item.textContent?.trim())).toEqual([
      'Close panel',
      'Float panel',
      'Maximize panel',
      'Move to left',
      'Move to right',
      'Move to bottom',
      'Reset layout',
    ]);
    await select(items, 'Close panel');
    expect(current.closePanel).toHaveBeenCalledOnce();

    items = await openMenu(current);
    await select(items, 'Float panel');
    expect(current.addFloatingGroup).toHaveBeenCalledWith(current.sourceGroup);

    items = await openMenu(current);
    await select(items, 'Maximize panel');
    expect(current.maximize).toHaveBeenCalledOnce();

    for (const [label, position] of [
      ['Move to left', 'left'],
      ['Move to right', 'right'],
      ['Move to bottom', 'bottom'],
    ] as const) {
      items = await openMenu(current);
      await select(items, label);
      expect(current.moveTo).toHaveBeenCalledWith({
        group: current.destinationGroup,
        position,
      });
    }

    items = await openMenu(current);
    await select(items, 'Reset layout');
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

  it('disables actions the current group cannot perform', async () => {
    const current = await mountMenu({ location: 'floating', hasDestination: false });
    const items = await openMenu(current);

    expect(items.find((item) => itemLabel(item) === 'Float panel')?.disabled).toBe(true);
    expect(items.find((item) => itemLabel(item) === 'Move to left')?.disabled).toBe(true);
    expect(items.find((item) => itemLabel(item) === 'Maximize panel')?.disabled).toBe(true);
  });
});
