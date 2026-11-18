// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonitorTextInlineEditor } from './MonitorTextInlineEditor.js';
import type { VisualObjectV1 } from '@joy-media/project-schema';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

const object: VisualObjectV1 = {
  id: 'title-1',
  kind: 'text',
  text: 'hello',
  textDocument: { version: 1, blocks: [{ id: 'title-block', runs: [{ text: 'hello' }] }] },
  textStyle: {
    fontFamily: 'Vazirmatn Variable',
    fontSizePx: 48,
    fontWeight: 700,
    italic: false,
    lineHeight: 1.15,
    tracking: 0,
    direction: 'rtl',
    align: 'end',
    fill: { kind: 'solid', color: '#fff' },
    blendMode: 'normal',
    opacity: 1,
  },
  transform: {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  },
};

const overlay = {
  elementId: 'title-1',
  clipId: 'clip-1',
  localToCanvas: [120, 0, 0, 48, 32, 24],
  corners: [
    { x: 32, y: 24 },
    { x: 152, y: 24 },
    { x: 152, y: 72 },
    { x: 32, y: 72 },
  ],
  handles: [],
  topCenter: { x: 92, y: 24 },
} as const;

function mount(onCommit = vi.fn(), onClose = vi.fn()) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <MonitorTextInlineEditor
        object={object}
        overlay={overlay}
        view={{ zoom: 1, panX: 0, panY: 0 }}
        onCommit={onCommit}
        onClose={onClose}
      />,
    );
  });
  return {
    editor: container.querySelector<HTMLTextAreaElement>('[data-monitor-text-editor]')!,
    onCommit,
    onClose,
  };
}

describe('MonitorTextInlineEditor', () => {
  it('commits on Escape once and keeps right-to-left direction', () => {
    const { editor, onCommit, onClose } = mount();
    expect(editor.dir).toBe('rtl');

    act(() => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    act(() => editor.blur());

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('hello');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('commits once when focus leaves the text box', () => {
    const { editor, onCommit, onClose } = mount();

    act(() => editor.blur());

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('hello');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
