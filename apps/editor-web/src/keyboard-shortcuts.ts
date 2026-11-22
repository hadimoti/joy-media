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
  | 'clip.copy'
  | 'clip.cut'
  | 'clip.paste'
  | 'snapping.toggle'
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

/** The clip's own keyboard behavior for Enter and Space. */
export function timelineClipSpaceBehavior(
  key: string,
  selected: boolean,
  modified: boolean,
): 'select' | 'bubble' | 'native' | 'ignore' {
  if (key === 'Enter') return 'select';
  if (key !== ' ') return 'ignore';
  if (modified) return 'native';
  return selected ? 'bubble' : 'select';
}

/**
 * True when Space may reach the editor transport from an ordinary editor
 * surface or the selected timeline clip body. Nested controls and dialog
 * contents keep their native or component-owned keys.
 */
export function canUseEditorSpaceTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object' || isEditableTarget(target)) return false;
  type ElementLike = Partial<HTMLElement> & { readonly tagName?: string };
  let element: ElementLike | null = target as ElementLike;
  let clip: ElementLike | undefined;
  let nestedInteractive = false;
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
    const role = element.getAttribute?.('role')?.toLowerCase();
    if (role === 'dialog' || role === 'alertdialog') return false;
    if (element.getAttribute?.('aria-roledescription') === 'timeline clip') {
      if (element.getAttribute('aria-pressed') !== 'true' || !element.getAttribute('data-clip-id'))
        return false;
      clip = element;
      break;
    }
    if (
      interactiveTags.has(element.tagName?.toUpperCase() ?? '') ||
      element.hasAttribute?.('data-trim-edge') === true ||
      (role !== undefined && interactiveRoles.has(role))
    ) {
      nestedInteractive = true;
    }
    element = element.parentElement ?? null;
  }
  if (clip !== undefined) return !nestedInteractive;
  return !isInteractiveTarget(target);
}

/**
 * True when text is selected on the page (a chat reply, a label). Ctrl+C then copies that text, and Ctrl+X
 * leaves it alone, instead of copying or cutting the selected timeline clip.
 */
export function pageTextIsSelected(
  selection: Pick<Selection, 'toString'> | null = typeof window === 'undefined'
    ? null
    : window.getSelection(),
): boolean {
  return selection !== null && selection.toString().length > 0;
}

export function actionYieldsToSelectedText(action: ShortcutAction): boolean {
  return action === 'clip.copy' || action === 'clip.cut';
}

const CONTROL_OWNED_ACTIONS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>([
  'playback.toggle',
  'playhead.back',
  'playhead.forward',
  'playhead.backFine',
  'playhead.forwardFine',
  'playhead.start',
  'playhead.end',
  'clip.delete',
]);

/**
 * A focused button, link or menu item owns Space, the arrows, Home, End and Delete
 * (a timeline clip and its trim handles use them). Every other shortcut (S, N,
 * Ctrl+D, Ctrl+Z ...) still reaches the editor, because clicking a timeline clip
 * leaves that clip focused and the editor keys must keep working after a click.
 */
export function interactiveTargetOwnsAction(action: ShortcutAction): boolean {
  return CONTROL_OWNED_ACTIONS.has(action);
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
    if (key === 'c' && !event.shiftKey) return 'clip.copy';
    if (key === 'x' && !event.shiftKey) return 'clip.cut';
    if (key === 'v' && !event.shiftKey) return 'clip.paste';
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
    case 'n':
    case 'N':
      return event.shiftKey ? undefined : 'snapping.toggle';
    case '?':
      return 'shortcuts.toggle';
    default:
      return undefined;
  }
}

export interface ShortcutReferenceRow {
  readonly keys: string;
  readonly action: string;
}

export interface ShortcutReferenceGroup {
  readonly title: 'Playback' | 'Editing' | 'View';
  readonly rows: readonly ShortcutReferenceRow[];
}

/** What the Keyboard Shortcuts dialog lists, in three groups. */
export const SHORTCUT_REFERENCE: readonly ShortcutReferenceGroup[] = [
  {
    title: 'Playback',
    rows: [
      { keys: 'Space', action: 'Toggle playback' },
      { keys: '← / →', action: 'Step back / forward 1s' },
      { keys: 'Shift+← / Shift+→', action: 'Fine step 100ms' },
      { keys: 'Home / End', action: 'Go to start / end' },
      { keys: ', / .', action: 'Step back / forward one frame' },
      { keys: '← / → (Monitor)', action: 'Step one frame when the Monitor has focus' },
      {
        keys: 'J / K / L',
        action: 'Reverse / stop / forward; press J or L again to go faster (up to 8x)',
      },
      { keys: 'I / O', action: 'Set in point / out point' },
      { keys: 'Shift+X', action: 'Clear in and out points' },
      { keys: '/', action: 'Play in to out' },
      { keys: '\\', action: 'Loop on or off' },
    ],
  },
  {
    title: 'Editing',
    rows: [
      { keys: 'Ctrl+Z', action: 'Undo' },
      { keys: 'Ctrl+Y', action: 'Redo' },
      { keys: 'Ctrl+C', action: 'Copy selected clips' },
      { keys: 'Ctrl+X', action: 'Cut selected clips' },
      { keys: 'Ctrl+V', action: 'Paste clips at playhead' },
      { keys: 'Ctrl+D', action: 'Duplicate the selected clips' },
      { keys: 'Delete / Backspace', action: 'Delete selected clip or marker' },
      { keys: 'S', action: 'Split clip at playhead' },
      { keys: 'N', action: 'Toggle timeline snapping' },
      { keys: 'V / B', action: 'Select tool / Split tool (Timeline)' },
      { keys: 'M', action: 'Add a marker at the playhead (Timeline)' },
      { keys: 'T / A', action: 'Add a visual / audio track (Timeline)' },
      { keys: '= / -', action: 'Zoom the Timeline in / out' },
      { keys: 'Shift+Z', action: 'Fit the Timeline to its width' },
      { keys: 'Shift+F', action: 'Freeze frame at the playhead (Timeline)' },
      { keys: 'Shift+R', action: 'Reverse the selected clip (Timeline)' },
      { keys: 'Shift+Delete', action: 'Ripple delete the selected clip (Timeline)' },
      { keys: 'Ctrl+I', action: 'Import media (Timeline)' },
      {
        keys: 'Tab / Shift+Tab (Monitor picture)',
        action: 'Select the next / previous element; past the last or first, focus leaves',
      },
      { keys: '← ↑ → ↓ (Monitor picture)', action: 'Move the selected element 1 pixel' },
      { keys: 'Shift+← ↑ → ↓ (Monitor picture)', action: 'Move the selected element 10 pixels' },
      {
        keys: 'Alt+← ↑ → ↓ (Monitor picture)',
        action: 'Scale the selected element 1% (Shift: 10%); Up and Right grow it',
      },
      {
        keys: '[ / ] (Monitor picture)',
        action: 'Rotate the selected element 1 degree (with Shift: 15 degrees)',
      },
      { keys: 'Esc (Monitor picture)', action: 'Leave the Monitor picture' },
    ],
  },
  {
    title: 'View',
    rows: [
      { keys: 'Ctrl+K', action: 'Command palette' },
      { keys: 'F', action: 'Full-screen preview (Esc leaves)' },
      { keys: '?', action: 'Toggle this panel' },
    ],
  },
];

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
  /**
   * Which binding is asked first when two want the same key. Higher first, 0 by default; equal ones keep their
   * order of registration. The Monitor's nudge asks before its frame step, so a selected clip moves with the arrows.
   */
  readonly priority?: number;
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
      // Stable insert: after every binding of the same or a higher priority.
      const rank = binding.priority ?? 0;
      let at = bindings.length;
      while (at > 0 && (bindings[at - 1]?.priority ?? 0) < rank) at -= 1;
      bindings.splice(at, 0, binding);
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
