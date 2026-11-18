// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { buildReadOnlyTextMenuItems, buildTextFieldMenuItems } from './text-field-menu.js';

function field(value: string, selectionStart: number, selectionEnd: number): HTMLTextAreaElement {
  const element = document.createElement('textarea');
  document.body.append(element);
  element.value = value;
  element.setSelectionRange(selectionStart, selectionEnd);
  return element;
}

const byLabel = (items: ReturnType<typeof buildTextFieldMenuItems>, label: string) =>
  items.find((item) => item.label === label)!;

describe('buildTextFieldMenuItems', () => {
  it('offers Undo, Redo, Cut, Copy, Paste and Select all in that order', () => {
    const items = buildTextFieldMenuItems(field('hello', 0, 0));
    expect(items.map((item) => item.label)).toEqual([
      'Undo',
      'Redo',
      'Cut',
      'Copy',
      'Paste',
      'Select all',
    ]);
  });

  it('enables Cut and Copy only while text is selected', () => {
    const none = buildTextFieldMenuItems(field('hello', 2, 2));
    expect(byLabel(none, 'Cut').disabled).toBe(true);
    expect(byLabel(none, 'Copy').disabled).toBe(true);
    const some = buildTextFieldMenuItems(field('hello', 0, 3));
    expect(byLabel(some, 'Cut').disabled).toBe(false);
    expect(byLabel(some, 'Copy').disabled).toBe(false);
  });

  it('disables the editing items on a read-only box and Select all on an empty one', () => {
    const readOnly = field('hello', 0, 3);
    readOnly.readOnly = true;
    const items = buildTextFieldMenuItems(readOnly);
    expect(byLabel(items, 'Cut').disabled).toBe(true);
    expect(byLabel(items, 'Paste').disabled).toBe(true);
    expect(byLabel(buildTextFieldMenuItems(field('', 0, 0)), 'Select all').disabled).toBe(true);
  });

  it('pastes the clipboard text at the caret and Select all selects the whole box', async () => {
    const box = field('ab', 1, 1);
    document.execCommand = vi.fn(() => false);
    const items = buildTextFieldMenuItems(box, async () => 'XY');
    byLabel(items, 'Paste').action!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(box.value).toBe('aXYb');
    byLabel(items, 'Select all').action!();
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, box.value.length]);
  });
});

describe('buildReadOnlyTextMenuItems', () => {
  it('offers Copy (off with nothing selected) and Select all', () => {
    const container = document.createElement('div');
    container.textContent = 'a reply';
    document.body.append(container);
    window.getSelection()?.removeAllRanges();
    const items = buildReadOnlyTextMenuItems(container);
    expect(items.map((item) => item.label)).toEqual(['Copy', 'Select all']);
    expect(items[0]!.disabled).toBe(true);
    items[1]!.action!();
    expect(window.getSelection()?.toString()).toBe('a reply');
  });
});
