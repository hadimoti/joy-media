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
  | 'playhead.frameBack'
  | 'playhead.frameForward'
  | 'jkl.reverse'
  | 'jkl.stop'
  | 'jkl.forward'
  | 'playback.loop'
  | 'range.in'
  | 'range.out'
  | 'range.clear'
  | 'range.playInOut'
  | 'monitor.fullscreen'
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

/** True when a focused control owns Space/Enter instead of the global editor. */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false;
  let element: (Partial<HTMLElement> & { readonly tagName?: string }) | null =
    target as Partial<HTMLElement> & { readonly tagName?: string };
  const interactiveTags = new Set(['A', 'BUTTON', 'DETAILS', 'SUMMARY']);
  const interactiveRoles = new Set([
    'button',
    'checkbox',
    'link',
    'menuitem',
    'option',
    'radio',
    'slider',
    'switch',
    'tab',
  ]);
  while (element !== null) {
    if (interactiveTags.has(element.tagName?.toUpperCase() ?? '')) return true;
    const role = element.getAttribute?.('role')?.toLowerCase();
    if (role !== undefined && interactiveRoles.has(role)) return true;
    element = element.parentElement ?? null;
  }
  return false;
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
    case ',':
      return 'playhead.frameBack';
    case '.':
      return 'playhead.frameForward';
    case 'j':
    case 'J':
      return event.shiftKey ? undefined : 'jkl.reverse';
    case 'k':
    case 'K':
      return event.shiftKey ? undefined : 'jkl.stop';
    case 'l':
    case 'L':
      return event.shiftKey ? undefined : 'jkl.forward';
    case 'i':
    case 'I':
      return event.shiftKey ? undefined : 'range.in';
    case 'o':
    case 'O':
      return event.shiftKey ? undefined : 'range.out';
    case 'X':
      return event.shiftKey ? 'range.clear' : undefined;
    case '\\':
      return 'playback.loop';
    case '/':
      return 'range.playInOut';
    case 'f':
    case 'F':
      return event.shiftKey ? undefined : 'monitor.fullscreen';
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

/** A key press as the scoped key table sees it (`code` is optional for tests). */
export interface ScopedKeyEvent extends ShortcutKeyEvent {
  readonly code?: string;
  readonly target?: EventTarget | null;
}

/**
 * One key owned by a part of the editor (ADR-0046 B5). It runs only while its
 * scope is active, for example while the pointer is over the Monitor or focus
 * is inside it. When no scoped key runs, the global key applies.
 */
export interface ScopedKeyBinding {
  readonly scope: string;
  /** True when this binding wants the key press. */
  readonly match: (event: ScopedKeyEvent) => boolean;
  /** Runs the key. The caller prevents the browser default. */
  readonly run: (event: ScopedKeyEvent) => void;
  /** Also runs while a text field has focus. Off by default. */
  readonly inTextFields?: boolean;
}

export interface ScopedKeyTable {
  /** Says how to tell whether a scope is active. Returns a function that removes it. */
  readonly setScope: (scope: string, isActive: () => boolean) => () => void;
  /** Adds a binding. Returns a function that removes it. */
  readonly register: (binding: ScopedKeyBinding) => () => void;
  /** Runs the first matching binding of an active scope. True when one ran. */
  readonly dispatch: (event: ScopedKeyEvent) => boolean;
}

/**
 * The focus-based key table: a scope wins while it is active (pointer over or
 * focus in it); otherwise `dispatch` returns false and the global key applies.
 * Later cards (nudge, frame step) register their keys here.
 */
export function createScopedKeyTable(): ScopedKeyTable {
  const scopes = new Map<string, () => boolean>();
  const bindings: ScopedKeyBinding[] = [];
  return {
    setScope(scope, isActive) {
      scopes.set(scope, isActive);
      return () => {
        if (scopes.get(scope) === isActive) scopes.delete(scope);
      };
    },
    register(binding) {
      bindings.push(binding);
      return () => {
        const index = bindings.indexOf(binding);
        if (index >= 0) bindings.splice(index, 1);
      };
    },
    dispatch(event) {
      const editing = isEditableTarget(event.target ?? null);
      for (const binding of [...bindings]) {
        if (editing && binding.inTextFields !== true) continue;
        if (!binding.match(event)) continue;
        const isActive = scopes.get(binding.scope);
        if (isActive === undefined || !isActive()) continue;
        binding.run(event);
        return true;
      }
      return false;
    },
  };
}

/** The editor's one scoped key table. */
export const scopedKeyTable: ScopedKeyTable = createScopedKeyTable();
