import { isEditableTarget, isInteractiveTarget } from '../keyboard-shortcuts.js';

/**
 * The Monitor's tools and the Space rule (ADR-0046 section 3). The tool is
 * part of the view, not the document: it is never saved and never undone.
 */

export type MonitorTool = 'select' | 'hand';
export type SpaceIntent = 'tap' | 'hold' | 'type';
/** The cursor the Monitor viewport shows. */
export type MonitorCursor = 'default' | 'grab' | 'grabbing';

/** Space held this long (or a pointer going down) is a hold, not a tap. */
export const SPACE_HOLD_MS = 250;

/** Decides what a Space press means. `textEditing` wins over everything. */
export function resolveSpaceIntent(input: {
  readonly textEditing: boolean;
  readonly heldMs: number;
  readonly pointerDown: boolean;
}): SpaceIntent {
  if (input.textEditing) return 'type';
  if (input.pointerDown || input.heldMs >= SPACE_HOLD_MS) return 'hold';
  return 'tap';
}

/** The tool in use: a Space hold lends the Hand for as long as Space is down. */
export function effectiveMonitorTool(tool: MonitorTool, spaceHeld: boolean): MonitorTool {
  return spaceHeld ? 'hand' : tool;
}

/** Open hand while the Hand is ready, closed hand while it drags. */
export function monitorCursor(tool: MonitorTool, panning: boolean): MonitorCursor {
  if (panning) return 'grabbing';
  return tool === 'hand' ? 'grab' : 'default';
}

/**
 * The Space press state machine. `press` on key-down, `pointerDown` when any
 * pointer goes down, `release` on key-up (returns what the press meant),
 * `cancel` when the window loses focus. After {@link SPACE_HOLD_MS} the press
 * becomes a hold and subscribers hear it (the Monitor shows an open hand).
 */
export interface SpaceGesture {
  readonly press: () => void;
  readonly pointerDown: () => void;
  readonly release: () => SpaceIntent | undefined;
  readonly cancel: () => void;
  readonly isDown: () => boolean;
  /** True while the press counts as a hold (the Hand is lent). */
  readonly isHolding: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createSpaceGesture(
  options: { readonly holdMs?: number; readonly now?: () => number } = {},
): SpaceGesture {
  const holdMs = options.holdMs ?? SPACE_HOLD_MS;
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<() => void>();
  let down = false;
  let holding = false;
  let downAt = 0;
  let pointerWentDown = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const setHolding = (next: boolean) => {
    if (holding === next) return;
    holding = next;
    for (const listener of [...listeners]) listener();
  };
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const reset = () => {
    clearTimer();
    down = false;
    pointerWentDown = false;
    setHolding(false);
  };

  return {
    press() {
      if (down) return;
      down = true;
      downAt = now();
      pointerWentDown = false;
      clearTimer();
      timer = setTimeout(() => {
        timer = undefined;
        if (down) setHolding(true);
      }, holdMs);
    },
    pointerDown() {
      if (!down) return;
      pointerWentDown = true;
      clearTimer();
      setHolding(true);
    },
    release() {
      if (!down) return undefined;
      const intent = holding
        ? 'hold'
        : resolveSpaceIntent({
            textEditing: false,
            heldMs: now() - downAt,
            pointerDown: pointerWentDown,
          });
      reset();
      return intent;
    },
    cancel: reset,
    isDown: () => down,
    isHolding: () => holding,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The editor's one Space gesture, shared by the global keys and the Monitor. */
export const monitorSpaceGesture: SpaceGesture = createSpaceGesture();

type SpaceKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'repeat' | 'target' | 'defaultPrevented' | 'preventDefault'
>;

/**
 * Window key handlers for Space. In a text field (or an in-place text edit)
 * Space types a space: nothing is prevented and nothing else happens. A focused
 * button keeps Space for itself. Otherwise key-down starts the gesture and
 * key-up decides: a tap toggles playback (on key-up), a hold does not.
 */
export function createSpaceKeyHandlers(
  gesture: SpaceGesture,
  onTap: () => void,
): {
  readonly keyDown: (event: SpaceKeyEvent) => SpaceIntent | undefined;
  readonly keyUp: (event: SpaceKeyEvent) => SpaceIntent | undefined;
} {
  return {
    keyDown(event) {
      if (event.key !== ' ' || event.defaultPrevented) return undefined;
      if (isEditableTarget(event.target)) return 'type';
      if (isInteractiveTarget(event.target)) return undefined;
      event.preventDefault();
      if (event.repeat) return undefined;
      gesture.press();
      return undefined;
    },
    keyUp(event) {
      if (event.key !== ' ' || !gesture.isDown()) return undefined;
      event.preventDefault();
      const intent = gesture.release();
      if (intent === 'tap') onTap();
      return intent;
    },
  };
}
