/**
 * D-071 parity: the menu list the live rows click (`MENU_SPEC` in tooling/qa/live/actions.mjs) is a hand copy of
 * the app's `APP_MENU_GROUPS` (apps/editor-web/src/app-menu.ts). This test compares the two, group by group and
 * item by item, so a menu item added, renamed, moved or re-shortcut in the app fails here until the copy follows.
 * The View and Window panel items are generated from PANEL_METADATA in the app, so they are compared too.
 */
import { describe, expect, it } from 'vitest';
import { APP_MENU_GROUPS } from '../../../apps/editor-web/src/app-menu.ts';
import { MENU_SPEC } from '../live/actions.mjs';

interface MenuRow {
  readonly id: string;
  readonly label: string;
  readonly shortcut: string;
  readonly disabled: boolean;
}

interface MenuGroupRow {
  readonly group: string;
  readonly items: readonly MenuRow[];
}

/** The app's menu as the live rows see it: a missing shortcut is '' and a missing disabled flag is false. */
function appMenu(): MenuGroupRow[] {
  return APP_MENU_GROUPS.map((group) => ({
    group: group.label,
    items: group.items.map((item) => ({
      id: item.id,
      label: item.label,
      shortcut: item.shortcut ?? '',
      disabled: item.disabled === true,
    })),
  }));
}

/** The live rows' copy of the same menu. */
function liveMenu(): MenuGroupRow[] {
  return MENU_SPEC.map((group) => ({
    group: group.group,
    items: group.items.map((item) => ({
      id: item.id,
      label: item.label,
      shortcut: item.shortcut,
      disabled: item.disabled === true,
    })),
  }));
}

describe('D-071 live menu list against the app menu', () => {
  it('has the same menu groups in the same order', () => {
    expect(liveMenu().map((group) => group.group)).toEqual(appMenu().map((group) => group.group));
  });

  it('has the same items, labels, shortcuts and disabled flags in the same order', () => {
    expect(liveMenu()).toEqual(appMenu());
  });

  it('lists every app menu action id once per menu, so a new id cannot be missed', () => {
    const appIds = appMenu().flatMap((group) => group.items.map((item) => item.id));
    const liveIds = liveMenu().flatMap((group) => group.items.map((item) => item.id));
    expect(liveIds).toEqual(appIds);
    expect(appIds.length).toBeGreaterThan(0);
  });
});
