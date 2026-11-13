// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ColorCompareButton } from './ColorCompareButton.js';
import { createColorGradeBypassStore } from './color-grade-bypass.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * T-K03/T-K04 review fix: Hold to compare always gives the grade back, also
 * on Escape, on blur, on a pointer let go or cancelled outside the button,
 * and when the button goes away.
 */

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function mountButton(store = createColorGradeBypassStore()) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(<ColorCompareButton store={store} />);
  });
  const button = container.querySelector<HTMLButtonElement>('[data-color-compare]')!;
  return { store, button };
}

function fire(target: EventTarget, event: Event): void {
  act(() => {
    target.dispatchEvent(event);
  });
}

function pointer(type: string, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
}

function key(type: 'keydown' | 'keyup', name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true, ...init });
}

/** Holds the button with the pointer, the button focused (as after a real press). */
function holdWithPointer(button: HTMLButtonElement): void {
  act(() => button.focus());
  fire(button, pointer('pointerdown'));
}

describe('Hold to compare lets go', () => {
  it('on Escape while the pointer is held and the button keeps the focus', () => {
    const { store, button } = mountButton();
    holdWithPointer(button);
    expect(store.get()).toBe(true);
    expect(document.activeElement).toBe(button);
    const escape = key('keydown', 'Escape');
    fire(button, escape);
    expect(store.get()).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(escape.defaultPrevented).toBe(true);
    // The pointer let go afterwards changes nothing.
    fire(button, pointer('pointerup'));
    expect(store.get()).toBe(false);
  });

  it('on Escape pressed with the focus somewhere else', () => {
    const { store, button } = mountButton();
    fire(button, pointer('pointerdown'));
    expect(store.get()).toBe(true);
    fire(document.body, key('keydown', 'Escape'));
    expect(store.get()).toBe(false);
  });

  it('on Escape while Space is held, and the key repeats do not bring it back', () => {
    const { store, button } = mountButton();
    fire(button, key('keydown', ' '));
    expect(store.get()).toBe(true);
    fire(button, key('keydown', 'Escape'));
    expect(store.get()).toBe(false);
    fire(button, key('keydown', ' ', { repeat: true }));
    expect(store.get()).toBe(false);
    fire(button, key('keyup', ' '));
    expect(store.get()).toBe(false);
  });

  it('on blur', () => {
    const { store, button } = mountButton();
    holdWithPointer(button);
    expect(store.get()).toBe(true);
    act(() => button.blur());
    expect(store.get()).toBe(false);
  });

  it('when the window loses the focus', () => {
    const { store, button } = mountButton();
    fire(button, pointer('pointerdown'));
    fire(window, new Event('blur'));
    expect(store.get()).toBe(false);
  });

  it('on a pointer let go outside the button', () => {
    const { store, button } = mountButton();
    const outside = document.createElement('div');
    document.body.append(outside);
    fire(button, pointer('pointerdown'));
    expect(store.get()).toBe(true);
    fire(outside, pointer('pointerup'));
    expect(store.get()).toBe(false);
    outside.remove();
  });

  it('on pointer cancel, on the button and outside it', () => {
    const { store, button } = mountButton();
    fire(button, pointer('pointerdown'));
    fire(button, pointer('pointercancel'));
    expect(store.get()).toBe(false);
    fire(button, pointer('pointerdown'));
    expect(store.get()).toBe(true);
    fire(document.body, pointer('pointercancel'));
    expect(store.get()).toBe(false);
  });

  it('on unmount while held', () => {
    const { store, button } = mountButton();
    holdWithPointer(button);
    expect(store.get()).toBe(true);
    act(() => root!.unmount());
    root = undefined;
    expect(store.get()).toBe(false);
  });
});
