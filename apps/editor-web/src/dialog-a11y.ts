import { useEffect, useRef, type RefObject } from 'react';

const DIALOG_FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface DialogFocusableSpec {
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
}

export type DialogKeyAction =
  | { readonly type: 'none' }
  | { readonly type: 'close' }
  | { readonly type: 'focus'; readonly index: number };

export function resolveDialogInitialFocusIndex(
  items: readonly DialogFocusableSpec[],
): number | undefined {
  const firstAutoFocus = items.findIndex((item) => item.disabled !== true && item.autoFocus);
  if (firstAutoFocus >= 0) return firstAutoFocus;
  const firstEnabled = items.findIndex((item) => item.disabled !== true);
  return firstEnabled >= 0 ? firstEnabled : undefined;
}

export function resolveDialogKeyAction(args: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly activeIndex: number;
  readonly focusableCount: number;
}): DialogKeyAction {
  if (args.key === 'Escape') return { type: 'close' };
  if (args.key !== 'Tab' || args.focusableCount <= 0) return { type: 'none' };
  const direction = args.shiftKey ? -1 : 1;
  const index =
    (((args.activeIndex + direction) % args.focusableCount) + args.focusableCount) %
    args.focusableCount;
  return { type: 'focus', index };
}

export function useAccessibleDialog(args: {
  readonly open: boolean;
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly initialFocusSelector?: string | undefined;
}): void {
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const onCloseRef = useRef(args.onClose);
  onCloseRef.current = args.onClose;

  useEffect(() => {
    if (args.open && !wasOpenRef.current) {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    if (!args.open && wasOpenRef.current) {
      if (openerRef.current?.isConnected) openerRef.current.focus();
      openerRef.current = null;
    }
    wasOpenRef.current = args.open;
  }, [args.open]);

  // The dialog can rerender while it is open (for example while a user types in
  // a form field). Keep the focus/trap lifecycle tied to the open transition;
  // re-running it for every inline callback identity would steal focus back to
  // the first control on every render.
  useEffect(() => {
    if (!args.open) return;
    const container = args.containerRef.current;
    if (container === null) return;
    const initialTarget = resolveDialogInitialFocusTarget(container, args.initialFocusSelector);
    const frame = window.requestAnimationFrame(() => initialTarget.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      const nodes = dialogFocusableElements(container);
      const currentIndex = nodes.findIndex((node) => node === document.activeElement);
      const action = resolveDialogKeyAction({
        key: event.key,
        shiftKey: event.shiftKey,
        activeIndex: currentIndex >= 0 ? currentIndex : 0,
        focusableCount: nodes.length,
      });
      if (action.type === 'close') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (action.type !== 'focus') return;
      event.preventDefault();
      nodes[action.index]?.focus();
    };
    container.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      container.removeEventListener('keydown', onKeyDown);
    };
  }, [args.open]);
}

function resolveDialogInitialFocusTarget(
  container: HTMLElement,
  selector: string | undefined,
): HTMLElement {
  if (selector !== undefined) {
    // querySelector treats a comma-separated selector as one set and returns
    // the first match in document order. Try each alternative in author order
    // so a preferred visible control wins over an earlier hidden fallback.
    for (const candidate of selector.split(',')) {
      const match = container.querySelector<HTMLElement>(candidate.trim());
      if (match !== null && match.tabIndex >= 0 && !match.hasAttribute('disabled')) {
        return match;
      }
    }
  }
  return dialogFocusableElements(container)[0] ?? container;
}

function dialogFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)).filter(
    (element) => {
      if (element.tabIndex < 0) return false;
      if (element.hasAttribute('disabled')) return false;
      if (element.getAttribute('aria-hidden') === 'true') return false;
      return true;
    },
  );
}
