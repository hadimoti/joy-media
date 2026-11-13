import type { TimeUs } from '@joy-media/project-schema';
import { APP_MENU_GROUPS, type AppMenuActionId, type AppMenuItem } from './app-menu.js';

export interface EphemeralEditorState {
  readonly selectedIds: readonly string[];
  readonly playheadUs: TimeUs;
}

export const EMPTY_EDITOR_STATE: EphemeralEditorState = { selectedIds: [], playheadUs: 0 };

/** One command-palette entry. Every menu action is one entry, under the same id. */
export interface EditorAction {
  readonly id: AppMenuActionId;
  readonly title: string;
  readonly shortcut: string;
  readonly item: AppMenuItem;
}

/**
 * The palette list is built from the menu catalog, so every menu action is in the
 * palette. An id that sits in two menus (Delete is in Edit and Clip) appears once.
 */
export function paletteActionsFromMenu(): readonly EditorAction[] {
  const seen = new Map<AppMenuActionId, EditorAction>();
  for (const group of APP_MENU_GROUPS) {
    for (const item of group.items) {
      if (seen.has(item.id)) continue;
      seen.set(item.id, {
        id: item.id,
        title: item.label,
        shortcut: item.shortcut ?? '',
        item,
      });
    }
  }
  return [...seen.values()];
}

export const EDITOR_ACTIONS: readonly EditorAction[] = paletteActionsFromMenu();

export function searchActions(query: string): readonly EditorAction[] {
  const needle = query.trim().toLowerCase();
  return needle.length === 0
    ? EDITOR_ACTIONS
    : EDITOR_ACTIONS.filter((action) => action.title.toLowerCase().includes(needle));
}
