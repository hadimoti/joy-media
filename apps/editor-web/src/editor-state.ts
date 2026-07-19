import type { TimeUs } from '@joy-media/project-schema';

export interface EphemeralEditorState {
  readonly selectedIds: readonly string[];
  readonly playheadUs: TimeUs;
}

export const EMPTY_EDITOR_STATE: EphemeralEditorState = { selectedIds: [], playheadUs: 0 };

export interface EditorAction {
  readonly id: string;
  readonly title: string;
  readonly shortcut: string;
}

export const EDITOR_ACTIONS: readonly EditorAction[] = [
  { id: 'history.undo', title: 'Undo', shortcut: 'Mod+Z' },
  { id: 'history.redo', title: 'Redo', shortcut: 'Mod+Shift+Z' },
  { id: 'view.commandPalette', title: 'Open Command Palette', shortcut: 'Mod+K' },
];

export function searchActions(query: string): readonly EditorAction[] {
  const needle = query.trim().toLowerCase();
  return needle.length === 0
    ? EDITOR_ACTIONS
    : EDITOR_ACTIONS.filter((action) => action.title.toLowerCase().includes(needle));
}
