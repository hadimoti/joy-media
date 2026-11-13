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
  { id: 'history.undo', title: 'Undo', shortcut: 'Ctrl+Z' },
  { id: 'history.redo', title: 'Redo', shortcut: 'Ctrl+Shift+Z' },
  { id: 'view.commandPalette', title: 'Open Command Palette', shortcut: 'Ctrl+K' },
  { id: 'monitor.frameBack', title: 'Monitor: step back one frame', shortcut: ',' },
  { id: 'monitor.frameForward', title: 'Monitor: step forward one frame', shortcut: '.' },
  {
    id: 'monitor.reverse',
    title: 'Monitor: play in reverse (J, press again to go faster)',
    shortcut: 'J',
  },
  { id: 'monitor.stop', title: 'Monitor: stop (K)', shortcut: 'K' },
  {
    id: 'monitor.forward',
    title: 'Monitor: play forward (L, press again to go faster)',
    shortcut: 'L',
  },
  { id: 'monitor.loop', title: 'Monitor: loop on or off', shortcut: '\\' },
  { id: 'monitor.setIn', title: 'Monitor: set in point', shortcut: 'I' },
  { id: 'monitor.setOut', title: 'Monitor: set out point', shortcut: 'O' },
  { id: 'monitor.clearMarks', title: 'Monitor: clear in and out points', shortcut: 'Shift+X' },
  { id: 'monitor.playInToOut', title: 'Monitor: play in to out', shortcut: '/' },
  { id: 'monitor.fullscreen', title: 'Monitor: full-screen preview (Esc leaves)', shortcut: 'F' },
];

export function searchActions(query: string): readonly EditorAction[] {
  const needle = query.trim().toLowerCase();
  return needle.length === 0
    ? EDITOR_ACTIONS
    : EDITOR_ACTIONS.filter((action) => action.title.toLowerCase().includes(needle));
}
