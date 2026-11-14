import type { ShortcutKeyEvent } from './keyboard-shortcuts.js';

/** The key of the Timeline scope: it works while the pointer is over the timeline or focus is inside it. */
export const TIMELINE_KEY_SCOPE = 'timeline';

export type TimelineToolKeyAction =
  | 'tool.select'
  | 'tool.split'
  | 'marker.add'
  | 'track.addVisual'
  | 'track.addAudio'
  | 'zoom.in'
  | 'zoom.out'
  | 'zoom.fit'
  | 'clip.freeze'
  | 'clip.reverse'
  | 'clip.rippleDelete'
  | 'media.import';

/**
 * The Timeline's tool keys (the toolbar buttons and the clip menu show them): V select tool, B split tool, M marker,
 * T add visual track, A add audio track, = / + zoom in, - zoom out, Shift+Z fit to width, Shift+F freeze frame,
 * Shift+R reverse clip, Shift+Delete ripple delete, Ctrl/Cmd+I import media. S (split at the playhead), N (snapping), Ctrl/Cmd+C, X, V and D
 * are the global keys.
 */
export function timelineToolKey(event: ShortcutKeyEvent): TimelineToolKeyAction | undefined {
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key === 'i')
    return 'media.import';
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
  if (event.shiftKey) {
    if (key === 'z') return 'zoom.fit';
    if (key === 'f') return 'clip.freeze';
    if (key === 'r') return 'clip.reverse';
    if (event.key === 'Delete' || event.key === 'Backspace') return 'clip.rippleDelete';
    return event.key === '+' ? 'zoom.in' : undefined;
  }
  switch (key) {
    case 'v':
      return 'tool.select';
    case 'b':
      return 'tool.split';
    case 'm':
      return 'marker.add';
    case 't':
      return 'track.addVisual';
    case 'a':
      return 'track.addAudio';
    case '=':
    case '+':
      return 'zoom.in';
    case '-':
      return 'zoom.out';
    default:
      return undefined;
  }
}
