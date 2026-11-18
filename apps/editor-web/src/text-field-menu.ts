import type { ContextMenuItem } from './TimelineContextMenu.js';

type TextField = HTMLTextAreaElement | HTMLInputElement;

/** Puts text where the caret is, as one typed edit so Undo still works; falls back to setRangeText. */
function insertText(field: TextField, text: string): void {
  field.focus();
  if (document.execCommand('insertText', false, text)) return;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText(text, start, end, 'end');
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * The right-click menu of a text box: Undo, Redo, Cut, Copy, Paste and Select all. Cut, copy, undo and redo
 * use the browser's own editing commands, so they act on exactly what the box holds and keep its Undo history.
 */
export function buildTextFieldMenuItems(
  field: TextField,
  readClipboard: () => Promise<string> = () => navigator.clipboard.readText(),
): readonly ContextMenuItem[] {
  const hasSelection = (field.selectionEnd ?? 0) > (field.selectionStart ?? 0);
  const editable = !field.readOnly && !field.disabled;
  const run = (command: 'undo' | 'redo' | 'cut' | 'copy') => () => {
    field.focus();
    document.execCommand(command);
  };
  return [
    { label: 'Undo', action: run('undo'), disabled: !editable, shortcut: 'Ctrl+Z' },
    { label: 'Redo', action: run('redo'), disabled: !editable, shortcut: 'Ctrl+Y' },
    {
      label: 'Cut',
      action: run('cut'),
      disabled: !editable || !hasSelection,
      dividerBefore: true,
      shortcut: 'Ctrl+X',
    },
    { label: 'Copy', action: run('copy'), disabled: !hasSelection, shortcut: 'Ctrl+C' },
    {
      label: 'Paste',
      action: () => {
        void readClipboard()
          .then((text) => {
            if (text.length > 0) insertText(field, text);
          })
          .catch(() => undefined);
      },
      disabled: !editable,
      shortcut: 'Ctrl+V',
    },
    {
      label: 'Select all',
      action: () => {
        field.focus();
        field.select();
      },
      disabled: field.value.length === 0,
      dividerBefore: true,
      shortcut: 'Ctrl+A',
    },
  ];
}

/** The right-click menu over read-only text (a chat): Copy what is selected, or Select all of it. */
export function buildReadOnlyTextMenuItems(container: HTMLElement): readonly ContextMenuItem[] {
  const selected = window.getSelection()?.toString() ?? '';
  return [
    {
      label: 'Copy',
      disabled: selected.length === 0,
      shortcut: 'Ctrl+C',
      action: () => {
        document.execCommand('copy');
      },
    },
    {
      label: 'Select all',
      dividerBefore: true,
      shortcut: 'Ctrl+A',
      action: () => {
        const range = document.createRange();
        range.selectNodeContents(container);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      },
    },
  ];
}
