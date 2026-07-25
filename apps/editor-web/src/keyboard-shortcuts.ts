/** Global editor keyboard shortcuts (WP-16 UI pass): pure key → action mapping. */

export type ShortcutAction =
  | 'playback.toggle'
  | 'history.undo'
  | 'history.redo'
  | 'palette.toggle'
  | 'palette.close'
  | 'clip.split'
  | 'clip.delete'
  | 'clip.duplicate'
  | 'playhead.back'
  | 'playhead.forward'
  | 'playhead.backFine'
  | 'playhead.forwardFine'
  | 'playhead.start'
  | 'playhead.end'
  | 'shortcuts.toggle';

export interface ShortcutKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** True when the event target is a place where typing must not trigger shortcuts. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false;
  const element = target as Partial<HTMLElement> & { readonly tagName?: string };
  const tag = element.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return element.isContentEditable === true;
}

/** Resolve a keydown to an editor action, or undefined when the key is unbound. */
export function resolveShortcut(event: ShortcutKeyEvent): ShortcutAction | undefined {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !event.altKey) {
    const key = event.key.toLowerCase();
    if (key === 'z') return event.shiftKey ? 'history.redo' : 'history.undo';
    if (key === 'y' && !event.shiftKey) return 'history.redo';
    if (key === 'k' && !event.shiftKey) return 'palette.toggle';
    if (key === 'd' && !event.shiftKey) return 'clip.duplicate';
    return undefined;
  }
  if (event.altKey) return undefined;
  switch (event.key) {
    case ' ':
      return 'playback.toggle';
    case 'Escape':
      return 'palette.close';
    case 'ArrowLeft':
      return event.shiftKey ? 'playhead.backFine' : 'playhead.back';
    case 'ArrowRight':
      return event.shiftKey ? 'playhead.forwardFine' : 'playhead.forward';
    case 'Home':
      return 'playhead.start';
    case 'End':
      return 'playhead.end';
    case 'Delete':
    case 'Backspace':
      return 'clip.delete';
    case 's':
    case 'S':
      return event.shiftKey ? undefined : 'clip.split';
    case '?':
      return 'shortcuts.toggle';
    default:
      return undefined;
  }
}
