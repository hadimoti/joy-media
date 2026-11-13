import { useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import {
  getAppDialogQueue,
  settleAppDialog,
  subscribeAppDialogs,
  type ConfirmDialogOptions,
  type PromptDialogOptions,
} from './app-dialogs.js';
import { usePopupsClosedWhile } from './popup-manager.js';
import './AppDialogs.css';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select, textarea, a[href]';

export interface ModalKeyOptions {
  readonly dialogRef: RefObject<HTMLElement | null>;
  readonly primaryRef: RefObject<HTMLElement | null>;
  /** Element that takes focus when the dialog opens. */
  readonly initialFocusRef: RefObject<HTMLElement | null>;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * Modal behaviour shared by both dialogs: focus moves in on open and back out on close, Tab stays inside the dialog,
 * Escape cancels, and Enter confirms. Enter on a focused Cancel button keeps the button's own action. The listener is
 * in the capture phase, so the editor's keyboard shortcuts never see keys pressed while a dialog is open.
 */
export function useModalKeys({
  dialogRef,
  primaryRef,
  initialFocusRef,
  onConfirm,
  onCancel,
}: ModalKeyOptions): void {
  const handlers = useRef({ onConfirm, onCancel });
  useEffect(() => {
    handlers.current = { onConfirm, onCancel };
  });

  useEffect(() => {
    const returnFocusTo =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    initialFocusRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        handlers.current.onCancel();
        return;
      }
      if (event.key === 'Enter') {
        const focused = document.activeElement;
        if (focused instanceof HTMLButtonElement && focused !== primaryRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        handlers.current.onConfirm();
        return;
      }
      if (event.key === 'Tab') {
        const dialog = dialogRef.current;
        if (dialog === null) return;
        const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
        const first = items[0];
        const last = items[items.length - 1];
        if (first === undefined || last === undefined) return;
        const active = document.activeElement;
        const insideDialog = active !== null && dialog.contains(active);
        if (event.shiftKey && (!insideDialog || active === first)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (!insideDialog || active === last)) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      if (returnFocusTo?.isConnected) returnFocusTo.focus();
    };
  }, [dialogRef, primaryRef, initialFocusRef]);
}

export type ConfirmDialogProps = ConfirmDialogOptions & {
  readonly onResolve: (value: boolean) => void;
};

/** Yes or no question. Enter and the confirm button resolve true; Esc and Cancel resolve false. */
export function ConfirmDialog({
  message,
  title,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  tone = 'default',
  onResolve,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();

  useModalKeys({
    dialogRef,
    primaryRef: confirmRef,
    initialFocusRef: confirmRef,
    onConfirm: () => onResolve(true),
    onCancel: () => onResolve(false),
  });

  return (
    <div className="app-dialog-backdrop">
      <div
        ref={dialogRef}
        className="app-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={title === undefined ? undefined : titleId}
        aria-label={title === undefined ? 'Confirm' : undefined}
        aria-describedby={messageId}
      >
        {title !== undefined && (
          <h2 id={titleId} className="app-dialog-title">
            {title}
          </h2>
        )}
        <p id={messageId} className="app-dialog-message">
          {message}
        </p>
        <div className="app-dialog-actions">
          <button type="button" className="app-dialog-button" onClick={() => onResolve(false)}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={
              tone === 'danger'
                ? 'app-dialog-button app-dialog-button-primary app-dialog-button-danger'
                : 'app-dialog-button app-dialog-button-primary'
            }
            onClick={() => onResolve(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export type PromptDialogProps = PromptDialogOptions & {
  readonly onResolve: (value: string | null) => void;
};

/** One line of text. Enter resolves the typed text; Esc and Cancel resolve null. */
export function PromptDialog({
  message,
  title,
  defaultValue = '',
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  onResolve,
}: PromptDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [value, setValue] = useState(defaultValue);
  const titleId = useId();
  const messageId = useId();
  const inputId = useId();

  useModalKeys({
    dialogRef,
    primaryRef: confirmRef,
    initialFocusRef: inputRef,
    onConfirm: () => onResolve(value),
    onCancel: () => onResolve(null),
  });

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  return (
    <div className="app-dialog-backdrop">
      <div
        ref={dialogRef}
        className="app-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title === undefined ? undefined : titleId}
        aria-label={title === undefined ? 'Enter a value' : undefined}
      >
        {title !== undefined && (
          <h2 id={titleId} className="app-dialog-title">
            {title}
          </h2>
        )}
        <label id={messageId} htmlFor={inputId} className="app-dialog-message">
          {message}
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          className="app-dialog-input"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          autoComplete="off"
        />
        <div className="app-dialog-actions">
          <button type="button" className="app-dialog-button" onClick={() => onResolve(null)}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="app-dialog-button app-dialog-button-primary"
            onClick={() => onResolve(value)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Draws the open dialog, if any. Mount it once at the app root. Only the oldest request is shown; the others wait in
 * the queue.
 */
export function AppDialogHost() {
  const queue = useSyncExternalStore(subscribeAppDialogs, getAppDialogQueue, getAppDialogQueue);
  const active = queue[0];
  // A confirm or prompt dialog is modal: it closes every open popup (OB-18).
  usePopupsClosedWhile(active !== undefined);
  if (active === undefined) return null;
  if (active.kind === 'confirm') {
    return (
      <ConfirmDialog
        key={active.id}
        {...active.options}
        onResolve={(value) => settleAppDialog(active.id, value)}
      />
    );
  }
  return (
    <PromptDialog
      key={active.id}
      {...active.options}
      onResolve={(value) => settleAppDialog(active.id, value)}
    />
  );
}
