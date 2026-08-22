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

  useEffect(() => {
    if (!args.open) return;
    const container = args.containerRef.current;
    if (container === null) return;
    const focusables = dialogFocusableElements(container);
    const initialTarget =
      (args.initialFocusSelector === undefined
        ? undefined
        : (container.querySelector(args.initialFocusSelector) as HTMLElement | null)) ??
      focusables[0] ??
      container;
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
        args.onClose();
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
  }, [args.containerRef, args.initialFocusSelector, args.onClose, args.open]);
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
