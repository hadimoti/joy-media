// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  SHORTCUT_REFERENCE,
  canUseEditorSpaceTarget,
  interactiveTargetOwnsAction,
  isEditableTarget,
  isInteractiveTarget,
  resolveShortcut,
  timelineClipSpaceBehavior,
} from './keyboard-shortcuts.js';

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

describe('resolveShortcut for the Monitor transport (T-M10)', () => {
  it('maps frame steps, J K L, in and out, loop, play in to out and full screen', () => {
    expect(resolveShortcut(key(','))).toBe('playhead.frameBack');
    expect(resolveShortcut(key('.'))).toBe('playhead.frameForward');
    expect(resolveShortcut(key('j'))).toBe('jkl.reverse');
    expect(resolveShortcut(key('K'))).toBe('jkl.stop');
    expect(resolveShortcut(key('l'))).toBe('jkl.forward');
    expect(resolveShortcut(key('i'))).toBe('range.in');
    expect(resolveShortcut(key('O'))).toBe('range.out');
    expect(resolveShortcut(key('X', { shiftKey: true }))).toBe('range.clear');
    expect(resolveShortcut(key('x'))).toBeUndefined();
    expect(resolveShortcut(key('\\'))).toBe('playback.loop');
    expect(resolveShortcut(key('/'))).toBe('range.playInOut');
    expect(resolveShortcut(key('f'))).toBe('monitor.fullscreen');
  });

  it('leaves Shift and Ctrl combinations to other actions', () => {
    expect(resolveShortcut(key('J', { shiftKey: true }))).toBeUndefined();
    expect(resolveShortcut(key('F', { shiftKey: true }))).toBeUndefined();
    expect(resolveShortcut(key('k', { ctrlKey: true }))).toBe('palette.toggle');
    expect(resolveShortcut(key('i', { ctrlKey: true }))).toBeUndefined();
    expect(resolveShortcut(key('l', { altKey: true }))).toBeUndefined();
  });
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
    expect(resolveShortcut(key('n'))).toBe('snapping.toggle');
    expect(resolveShortcut(key('N'))).toBe('snapping.toggle');
    expect(resolveShortcut(key('Delete'))).toBe('clip.delete');
    expect(resolveShortcut(key('Backspace'))).toBe('clip.delete');
    expect(resolveShortcut(key('c', { ctrlKey: true }))).toBe('clip.copy');
    expect(resolveShortcut(key('c', { metaKey: true }))).toBe('clip.copy');
    expect(resolveShortcut(key('x', { ctrlKey: true }))).toBe('clip.cut');
    expect(resolveShortcut(key('x', { metaKey: true }))).toBe('clip.cut');
    expect(resolveShortcut(key('v', { ctrlKey: true }))).toBe('clip.paste');
    expect(resolveShortcut(key('v', { metaKey: true }))).toBe('clip.paste');
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

  it('a focused control owns Space, arrows, Home, End and Delete but not the editor letter keys', () => {
    for (const owned of [
      'playback.toggle',
      'playhead.back',
      'playhead.forward',
      'clip.delete',
    ] as const) {
      expect(interactiveTargetOwnsAction(owned)).toBe(true);
    }
    // Clicking a timeline clip leaves it focused: S, N, Ctrl+D, Ctrl+Z must still work.
    for (const free of [
      'clip.split',
      'clip.duplicate',
      'snapping.toggle',
      'history.undo',
      'clip.copy',
    ] as const) {
      expect(interactiveTargetOwnsAction(free)).toBe(false);
    }
  });

  it('recognizes a control ancestor for nested icon targets', () => {
    const button = { tagName: 'BUTTON', parentElement: null };
    const icon = { tagName: 'SPAN', parentElement: button };
    expect(isInteractiveTarget(icon as unknown as EventTarget)).toBe(true);
  });
});

describe('canUseEditorSpaceTarget', () => {
  it('allows ordinary editor surfaces and only the selected clip body', () => {
    const ordinary = document.createElement('div');
    expect(canUseEditorSpaceTarget(ordinary)).toBe(true);
    const clip = document.createElement('div');
    clip.setAttribute('role', 'button');
    clip.setAttribute('aria-roledescription', 'timeline clip');
    clip.setAttribute('aria-pressed', 'true');
    clip.setAttribute('data-clip-id', 'clip-1');
    expect(canUseEditorSpaceTarget(clip)).toBe(true);
    clip.setAttribute('aria-pressed', 'false');
    expect(canUseEditorSpaceTarget(clip)).toBe(false);
  });

  it('keeps trim handles, links, buttons, editable fields and dialogs out of transport', () => {
    const clip = document.createElement('div');
    clip.setAttribute('role', 'button');
    clip.setAttribute('aria-roledescription', 'timeline clip');
    clip.setAttribute('aria-pressed', 'true');
    clip.setAttribute('data-clip-id', 'clip-1');
    const trim = document.createElement('button');
    trim.dataset.trimEdge = 'start';
    clip.append(trim);
    expect(canUseEditorSpaceTarget(trim)).toBe(false);
    expect(canUseEditorSpaceTarget(document.createElement('button'))).toBe(false);
    expect(canUseEditorSpaceTarget(document.createElement('a'))).toBe(false);
    expect(canUseEditorSpaceTarget(document.createElement('input'))).toBe(false);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const dialogBody = document.createElement('div');
    dialog.append(dialogBody);
    expect(canUseEditorSpaceTarget(dialogBody)).toBe(false);
    expect(canUseEditorSpaceTarget(null)).toBe(false);
  });

  it('lets the focused playhead ruler (a slider) play and pause, but nothing nested inside it', () => {
    const ruler = document.createElement('div');
    ruler.setAttribute('role', 'slider');
    ruler.setAttribute('data-editor-space-surface', '');
    // Without the marker a slider owns its keys.
    const plainSlider = document.createElement('div');
    plainSlider.setAttribute('role', 'slider');
    expect(canUseEditorSpaceTarget(plainSlider)).toBe(false);
    expect(canUseEditorSpaceTarget(ruler)).toBe(true);
    const nestedButton = document.createElement('button');
    ruler.append(nestedButton);
    expect(canUseEditorSpaceTarget(nestedButton)).toBe(false);
  });

  it('still refuses Space from a ruler that sits inside a dialog', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const ruler = document.createElement('div');
    ruler.setAttribute('role', 'slider');
    ruler.setAttribute('data-editor-space-surface', '');
    dialog.append(ruler);
    expect(canUseEditorSpaceTarget(ruler)).toBe(false);
  });
});

describe('timelineClipSpaceBehavior', () => {
  it('bubbles selected clip Space and selects unselected Space or Enter', () => {
    expect(timelineClipSpaceBehavior(' ', true, false)).toBe('bubble');
    expect(timelineClipSpaceBehavior(' ', false, false)).toBe('select');
    expect(timelineClipSpaceBehavior('Enter', true, false)).toBe('select');
    expect(timelineClipSpaceBehavior(' ', true, true)).toBe('native');
  });
});

describe('shortcut reference', () => {
  it('groups the shortcuts under Playback, Editing and View, in that order', () => {
    expect(SHORTCUT_REFERENCE.map((group) => group.title)).toEqual(['Playback', 'Editing', 'View']);
    const keysIn = (title: string) =>
      SHORTCUT_REFERENCE.find((group) => group.title === title)?.rows.map((row) => row.keys);
    expect(keysIn('Playback')).toContain('Space');
    expect(keysIn('Editing')).toContain('Ctrl+Z');
    expect(keysIn('Editing')).toContain('Ctrl+C');
    expect(keysIn('Editing')).toContain('Ctrl+X');
    expect(keysIn('Editing')).toContain('Ctrl+V');
    expect(keysIn('Editing')).toContain('N');
    expect(keysIn('View')).toContain('Ctrl+K');
  });

  it('lists the Monitor keyboard edits: Tab, Alt+arrows, [ ] and Esc (T-M12)', () => {
    const editing = SHORTCUT_REFERENCE.find((group) => group.title === 'Editing')?.rows.map(
      (row) => row.keys,
    );
    expect(editing).toEqual(
      expect.arrayContaining([
        'Tab / Shift+Tab (Monitor picture)',
        'Alt+← ↑ → ↓ (Monitor picture)',
        '[ / ] (Monitor picture)',
        'Esc (Monitor picture)',
      ]),
    );
  });
});

describe('selected page text and Ctrl+C', () => {
  it('copy and cut yield to text selected on the page, other keys do not', async () => {
    const { actionYieldsToSelectedText, pageTextIsSelected } =
      await import('./keyboard-shortcuts.js');
    expect(actionYieldsToSelectedText('clip.copy')).toBe(true);
    expect(actionYieldsToSelectedText('clip.cut')).toBe(true);
    expect(actionYieldsToSelectedText('clip.paste')).toBe(false);
    expect(actionYieldsToSelectedText('history.undo')).toBe(false);
    expect(pageTextIsSelected({ toString: () => 'hi' })).toBe(true);
    expect(pageTextIsSelected({ toString: () => '' })).toBe(false);
    expect(pageTextIsSelected(null)).toBe(false);
  });
});
