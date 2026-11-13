import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * One popup open at a time (OB-18).
 *
 * A popup is a header menu, drawer, popover or palette. Opening one closes the
 * others. A click outside the popup's root, Escape, or choosing an item closes
 * it, and focus returns to the element that opened it. A dialog closes every
 * popup when it opens (`usePopupsClosedWhile`).
 *
 * Without a `PopupProvider` each `usePopup` call keeps its own state, so a
 * component still works when it is rendered alone (tests, previews).
 */

export interface PopupCloseOptions {
  /** Return focus to the element that opened the popup. Defaults to true. */
  readonly restoreFocus?: boolean;
}

export interface PopupManager {
  /** Id of the one open popup, or null when none is open. */
  readonly openId: string | null;
  /** Opens `id` and closes whichever popup was open. `trigger` receives focus back on close. */
  readonly open: (id: string, trigger?: HTMLElement | null) => void;
  readonly toggle: (id: string, trigger?: HTMLElement | null) => void;
  readonly close: (id: string, options?: PopupCloseOptions) => void;
  readonly closeAll: (options?: PopupCloseOptions) => void;
  /** Returns a stable ref callback. Outside clicks are measured against this element. */
  readonly registerRoot: (id: string) => (element: HTMLElement | null) => void;
}

export interface PopupControl {
  readonly open: boolean;
  readonly show: (trigger?: HTMLElement | null) => void;
  readonly toggle: (trigger?: HTMLElement | null) => void;
  readonly close: (options?: PopupCloseOptions) => void;
  /** Attach to the element that holds both the trigger and the popup. */
  readonly rootRef: (element: HTMLElement | null) => void;
}

const FOCUSABLE_TARGET =
  'button, a[href], input, select, textarea, [contenteditable="true"], [tabindex]';

/**
 * A control that opens or toggles popup `id` carries `data-popup-trigger="<id>"`. Its
 * pointerdown counts as inside for that popup, however the popup was opened (a toolbar
 * button, a keyboard shortcut or a menu item), so its click toggles the popup.
 */
export const POPUP_TRIGGER_ATTRIBUTE = 'data-popup-trigger';

function isFocusableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(FOCUSABLE_TARGET) !== null;
}

function isTriggerOf(target: EventTarget | null, id: string): boolean {
  if (!(target instanceof Element)) return false;
  const trigger = target.closest(`[${POPUP_TRIGGER_ATTRIBUTE}]`);
  return trigger?.getAttribute(POPUP_TRIGGER_ATTRIBUTE) === id;
}

function usePopupStore(): PopupManager {
  const [openId, setOpenId] = useState<string | null>(null);
  const openIdRef = useRef<string | null>(null);
  // Bumped on every open and close. A deferred close captures it at detach time and acts only
  // if it is unchanged, so a popup closed and reopened in between is not closed by a stale check.
  const generationRef = useRef(0);
  const openerRef = useRef<HTMLElement | null>(null);
  const rootsRef = useRef(new Map<string, HTMLElement>());
  const rootRefsRef = useRef(new Map<string, (element: HTMLElement | null) => void>());

  const open = useCallback((id: string, trigger?: HTMLElement | null) => {
    if (openIdRef.current === id) return;
    if (trigger !== undefined && trigger !== null) {
      // An explicit trigger is the opener, even when this switches from another popup.
      openerRef.current = trigger;
    } else if (openIdRef.current === null) {
      // Without a trigger, the focused element opened it. When switching from another
      // popup with no trigger, keep the first opener.
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    openIdRef.current = id;
    generationRef.current += 1;
    setOpenId(id);
  }, []);

  const close = useCallback((id: string, options?: PopupCloseOptions) => {
    if (openIdRef.current !== id) return;
    const opener = openerRef.current;
    openerRef.current = null;
    openIdRef.current = null;
    generationRef.current += 1;
    setOpenId(null);
    if (options?.restoreFocus !== false && opener !== null && opener.isConnected) {
      opener.focus();
    }
  }, []);

  const toggle = useCallback(
    (id: string, trigger?: HTMLElement | null) => {
      if (openIdRef.current === id) close(id);
      else open(id, trigger);
    },
    [close, open],
  );

  const closeAll = useCallback(
    (options?: PopupCloseOptions) => {
      const current = openIdRef.current;
      if (current !== null) close(current, options);
    },
    [close],
  );

  const registerRoot = useCallback((id: string) => {
    let ref = rootRefsRef.current.get(id);
    if (ref === undefined) {
      const callback = (element: HTMLElement | null) => {
        if (element !== null) {
          rootsRef.current.set(id, element);
          return;
        }
        rootsRef.current.delete(id);
        if (openIdRef.current !== id) return;
        // The open popup's root has gone, so the popup is gone too. Check after the commit:
        // an inline ref callback detaches and re-attaches the same root on every render.
        const generation = generationRef.current;
        queueMicrotask(() => {
          // Act only if this is still the same open popup: no reattach, and no close or reopen
          // since the detach (which would bump the generation).
          if (rootsRef.current.has(id) || generationRef.current !== generation) return;
          if (openIdRef.current !== id) return;
          openIdRef.current = null;
          openerRef.current = null;
          generationRef.current += 1;
          setOpenId(null);
        });
      };
      rootRefsRef.current.set(id, callback);
      ref = callback;
    }
    return ref;
  }, []);

  useEffect(() => {
    if (openId === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootsRef.current.get(openId);
      const target = event.target;
      if (root === undefined || (target instanceof Node && root.contains(target))) return;
      const opener = openerRef.current;
      // The opener is part of the popup: its own click toggles the popup, so it must not
      // close here first and reopen on click (a toolbar button for the palette, for example).
      if (opener !== null && target instanceof Node && opener.contains(target)) return;
      // The popup's own trigger, whichever path opened it, is part of the popup too.
      if (isTriggerOf(target, openId)) return;
      close(openId, { restoreFocus: false });
      // Let the pointer's own focus change (mousedown) happen first. A click on
      // another focusable control keeps its focus; a click on plain background
      // returns focus to the opener.
      if (!isFocusableTarget(target) && opener !== null) {
        window.setTimeout(() => {
          if (openIdRef.current === null && opener.isConnected) opener.focus();
        }, 0);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(openId);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openId, close]);

  return useMemo(
    () => ({ openId, open, toggle, close, closeAll, registerRoot }),
    [openId, open, toggle, close, closeAll, registerRoot],
  );
}

const PopupContext = createContext<PopupManager | null>(null);

export function PopupProvider({ children }: { readonly children: ReactNode }) {
  const manager = usePopupStore();
  return <PopupContext.Provider value={manager}>{children}</PopupContext.Provider>;
}

/** The shared manager: `openId` plus the operations that work on any popup id. */
export function usePopupManager(): PopupManager {
  const shared = useContext(PopupContext);
  // Always called so the hook order is fixed; used only without a provider.
  const standalone = usePopupStore();
  return shared ?? standalone;
}

/** One popup, identified by a stable id such as `export-preset`. */
export function usePopup(id: string): PopupControl {
  const { openId, open, toggle, close, registerRoot } = usePopupManager();
  const isOpen = openId === id;
  return useMemo<PopupControl>(
    () => ({
      open: isOpen,
      show: (trigger) => open(id, trigger),
      toggle: (trigger) => toggle(id, trigger),
      close: (options) => close(id, options),
      rootRef: registerRoot(id),
    }),
    [id, isOpen, open, toggle, close, registerRoot],
  );
}

/** A dialog calls this with its open state. Opening the dialog closes every popup. */
export function usePopupsClosedWhile(dialogOpen: boolean): void {
  const { closeAll } = usePopupManager();
  useEffect(() => {
    if (dialogOpen) closeAll({ restoreFocus: false });
  }, [closeAll, dialogOpen]);
}
