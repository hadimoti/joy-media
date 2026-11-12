/**
 * Async confirm and prompt dialogs for the editor (replaces the browser's native confirm and prompt boxes).
 *
 * Callers `await confirmDialog({...})` or `await promptDialog({...})`. The request is queued here and drawn by
 * `AppDialogHost` (AppDialogs.tsx), which must be mounted once at the app root. Without a mounted host the promise
 * waits until one is mounted, so mount it in main.tsx and in any test that opens a dialog.
 */

export interface ConfirmDialogOptions {
  /** The question. Line breaks are kept. */
  readonly message: string;
  /** Optional heading. Without it the dialog shows only the message. */
  readonly title?: string;
  /** Label of the button that resolves true. Defaults to "OK". */
  readonly confirmLabel?: string;
  /** Label of the button that resolves false. Defaults to "Cancel". */
  readonly cancelLabel?: string;
  /** `danger` styles the confirm button for deletes and other actions that cannot be undone. */
  readonly tone?: 'default' | 'danger';
}

export interface PromptDialogOptions {
  /** The label above the text field. */
  readonly message: string;
  readonly title?: string;
  /** Text already in the field. It is selected when the dialog opens. */
  readonly defaultValue?: string;
  /** Label of the button that resolves with the typed text. Defaults to "OK". */
  readonly confirmLabel?: string;
  /** Label of the button that resolves null. Defaults to "Cancel". */
  readonly cancelLabel?: string;
}

export type AppDialogEntry =
  | {
      readonly id: number;
      readonly kind: 'confirm';
      readonly options: ConfirmDialogOptions;
      readonly settle: (value: boolean | string | null) => void;
    }
  | {
      readonly id: number;
      readonly kind: 'prompt';
      readonly options: PromptDialogOptions;
      readonly settle: (value: boolean | string | null) => void;
    };

let queue: readonly AppDialogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function enqueue(entry: AppDialogEntry): void {
  queue = [...queue, entry];
  emit();
}

/** Asks the owner to confirm. Resolves true only when the confirm button or Enter is used. Esc resolves false. */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    enqueue({
      id: nextId++,
      kind: 'confirm',
      options,
      settle: (value) => resolve(value === true),
    });
  });
}

/** Asks the owner for a line of text. Resolves the typed text, or null when cancelled. */
export function promptDialog(options: PromptDialogOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    enqueue({
      id: nextId++,
      kind: 'prompt',
      options,
      settle: (value) => resolve(typeof value === 'string' ? value : null),
    });
  });
}

/** Store subscription for the host. Returns the unsubscribe function. */
export function subscribeAppDialogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The open dialogs, oldest first. The first one is on screen. The array is replaced on every change. */
export function getAppDialogQueue(): readonly AppDialogEntry[] {
  return queue;
}

/** Closes a dialog and resolves its promise. Unknown ids are ignored. */
export function settleAppDialog(id: number, value: boolean | string | null): void {
  const entry = queue.find((candidate) => candidate.id === id);
  if (entry === undefined) return;
  queue = queue.filter((candidate) => candidate.id !== id);
  emit();
  entry.settle(value);
}
