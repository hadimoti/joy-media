import { describe, expect, it } from 'vitest';
import { isEditableTarget, isInteractiveTarget, resolveShortcut } from './keyboard-shortcuts.js';

const key = (
  k: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {},
) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('resolveShortcut', () => {
  it('maps transport and history keys', () => {
    expect(resolveShortcut(key(' '))).toBe('playback.toggle');
    expect(resolveShortcut(key('z', { ctrlKey: true }))).toBe('history.undo');
    expect(resolveShortcut(key('z', { metaKey: true }))).toBe('history.undo');
    expect(resolveShortcut(key('z', { ctrlKey: true, shiftKey: true }))).toBe('history.redo');
    expect(resolveShortcut(key('y', { ctrlKey: true }))).toBe('history.redo');
    expect(resolveShortcut(key('k', { ctrlKey: true }))).toBe('palette.toggle');
    expect(resolveShortcut(key('Escape'))).toBe('palette.close');
  });

  it('maps clip and playhead keys', () => {
    expect(resolveShortcut(key('s'))).toBe('clip.split');
    expect(resolveShortcut(key('Delete'))).toBe('clip.delete');
    expect(resolveShortcut(key('Backspace'))).toBe('clip.delete');
    expect(resolveShortcut(key('d', { ctrlKey: true }))).toBe('clip.duplicate');
    expect(resolveShortcut(key('d', { metaKey: true }))).toBe('clip.duplicate');
    expect(resolveShortcut(key('ArrowLeft'))).toBe('playhead.back');
    expect(resolveShortcut(key('ArrowRight', { shiftKey: true }))).toBe('playhead.forwardFine');
    expect(resolveShortcut(key('Home'))).toBe('playhead.start');
    expect(resolveShortcut(key('End'))).toBe('playhead.end');
  });

  it('leaves unbound and alt-modified keys alone', () => {
    expect(resolveShortcut(key('q'))).toBeUndefined();
    expect(resolveShortcut(key('s', { shiftKey: true }))).toBeUndefined();
    expect(resolveShortcut(key(' ', { altKey: true }))).toBeUndefined();
    expect(resolveShortcut(key('p', { ctrlKey: true }))).toBeUndefined();
  });
});

describe('isEditableTarget', () => {
  it('flags form fields and contenteditable, not buttons', () => {
    expect(isEditableTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true);
    expect(
      isEditableTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget),
    ).toBe(true);
    expect(isEditableTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('isInteractiveTarget', () => {
  it('lets focused controls own Space without toggling the global transport', () => {
    expect(isInteractiveTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(true);
    expect(
      isInteractiveTarget({
        tagName: 'DIV',
        getAttribute: () => 'menuitem',
      } as unknown as EventTarget),
    ).toBe(true);
    expect(isInteractiveTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
  });

  it('recognizes a control ancestor for nested icon targets', () => {
    const button = { tagName: 'BUTTON', parentElement: null };
    const icon = { tagName: 'SPAN', parentElement: button };
    expect(isInteractiveTarget(icon as unknown as EventTarget)).toBe(true);
  });
});
