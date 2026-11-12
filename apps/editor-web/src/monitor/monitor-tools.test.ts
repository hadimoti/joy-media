// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SPACE_HOLD_MS,
  createSpaceGesture,
  createSpaceKeyHandlers,
  effectiveMonitorTool,
  monitorCursor,
  resolveSpaceIntent,
} from './monitor-tools.js';

describe('resolveSpaceIntent', () => {
  it('is a tap under 250 ms with no pointer down', () => {
    expect(resolveSpaceIntent({ textEditing: false, heldMs: 0, pointerDown: false })).toBe('tap');
    expect(resolveSpaceIntent({ textEditing: false, heldMs: 249, pointerDown: false })).toBe('tap');
  });

  it('is a hold from 250 ms, or as soon as a pointer goes down', () => {
    expect(resolveSpaceIntent({ textEditing: false, heldMs: 250, pointerDown: false })).toBe(
      'hold',
    );
    expect(resolveSpaceIntent({ textEditing: false, heldMs: 10, pointerDown: true })).toBe('hold');
  });

  it('types a space while a text field has focus, whatever else happens', () => {
    expect(resolveSpaceIntent({ textEditing: true, heldMs: 0, pointerDown: false })).toBe('type');
    expect(resolveSpaceIntent({ textEditing: true, heldMs: 900, pointerDown: true })).toBe('type');
  });
});

describe('the Space gesture with fake timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a quick tap is a tap and never lends the Hand', () => {
    const gesture = createSpaceGesture();
    const heard = vi.fn();
    gesture.subscribe(heard);
    gesture.press();
    vi.advanceTimersByTime(SPACE_HOLD_MS - 1);
    expect(gesture.isHolding()).toBe(false);
    expect(gesture.release()).toBe('tap');
    vi.advanceTimersByTime(1000);
    expect(heard).not.toHaveBeenCalled();
    expect(gesture.isDown()).toBe(false);
  });

  it('a press held for 250 ms becomes a hold (open hand) and release gives the tool back', () => {
    const gesture = createSpaceGesture();
    const heard = vi.fn();
    gesture.subscribe(heard);
    gesture.press();
    vi.advanceTimersByTime(SPACE_HOLD_MS);
    expect(gesture.isHolding()).toBe(true);
    expect(effectiveMonitorTool('select', gesture.isHolding())).toBe('hand');
    expect(gesture.release()).toBe('hold');
    expect(gesture.isHolding()).toBe(false);
    expect(effectiveMonitorTool('select', gesture.isHolding())).toBe('select');
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('a pointer going down while Space is held makes it a hold at once', () => {
    const gesture = createSpaceGesture();
    gesture.press();
    vi.advanceTimersByTime(40);
    gesture.pointerDown();
    expect(gesture.isHolding()).toBe(true);
    vi.advanceTimersByTime(40);
    expect(gesture.release()).toBe('hold');
  });

  it('ignores a pointer down when Space is not held, and cancel never taps', () => {
    const gesture = createSpaceGesture();
    gesture.pointerDown();
    expect(gesture.isHolding()).toBe(false);
    gesture.press();
    gesture.cancel();
    expect(gesture.release()).toBeUndefined();
  });

  it('key repeat does not restart the clock', () => {
    const gesture = createSpaceGesture();
    gesture.press();
    vi.advanceTimersByTime(200);
    gesture.press();
    vi.advanceTimersByTime(60);
    expect(gesture.release()).toBe('hold');
  });
});

// jsdom does not compute isContentEditable, so set it like a browser would.
function editableDiv(): HTMLElement {
  const div = document.createElement('div');
  div.setAttribute('contenteditable', 'true');
  Object.defineProperty(div, 'isContentEditable', { value: true });
  return div;
}

describe('Space key handlers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const gesture = createSpaceGesture();
    const onTap = vi.fn();
    const handlers = createSpaceKeyHandlers(gesture, onTap);
    const down = (target: EventTarget, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key: ' ', cancelable: true, ...init });
      Object.defineProperty(event, 'target', { value: target });
      handlers.keyDown(event);
      return event;
    };
    const up = (target: EventTarget) => {
      const event = new KeyboardEvent('keyup', { key: ' ', cancelable: true });
      Object.defineProperty(event, 'target', { value: target });
      handlers.keyUp(event);
      return event;
    };
    return { gesture, onTap, down, up };
  }

  it('a tap plays or pauses on key-up, not on key-down', () => {
    const { onTap, down, up } = setup();
    const pressed = down(document.body);
    expect(pressed.defaultPrevented).toBe(true);
    expect(onTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    up(document.body);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('a hold does not play', () => {
    const { onTap, down, up, gesture } = setup();
    down(document.body);
    vi.advanceTimersByTime(300);
    expect(gesture.isHolding()).toBe(true);
    down(document.body, { repeat: true });
    up(document.body);
    expect(onTap).not.toHaveBeenCalled();
  });

  it('Space in a text field types a space: nothing is prevented and nothing plays', () => {
    const { onTap, down, up, gesture } = setup();
    for (const field of [
      document.createElement('input'),
      document.createElement('textarea'),
      editableDiv(),
    ]) {
      document.body.append(field);
      const pressed = down(field);
      expect(pressed.defaultPrevented).toBe(false);
      expect(gesture.isDown()).toBe(false);
      vi.advanceTimersByTime(400);
      expect(gesture.isHolding()).toBe(false);
      const released = up(field);
      expect(released.defaultPrevented).toBe(false);
    }
    expect(onTap).not.toHaveBeenCalled();
  });

  it('typing "a b" into a title keeps the space', () => {
    const { onTap, down } = setup();
    const title = document.createElement('input');
    document.body.append(title);
    title.focus();
    let value = '';
    for (const key of ['a', ' ', 'b']) {
      if (key === ' ') {
        if (!down(title).defaultPrevented) value += ' ';
      } else value += key;
    }
    expect(value).toBe('a b');
    expect(onTap).not.toHaveBeenCalled();
  });

  it('a focused button keeps Space for itself', () => {
    const { onTap, down, up } = setup();
    const button = document.createElement('button');
    document.body.append(button);
    expect(down(button).defaultPrevented).toBe(false);
    up(button);
    expect(onTap).not.toHaveBeenCalled();
  });
});

describe('Monitor cursor', () => {
  it('shows an open hand for the Hand and a closed hand while dragging', () => {
    expect(monitorCursor('select', false)).toBe('default');
    expect(monitorCursor('hand', false)).toBe('grab');
    expect(monitorCursor('hand', true)).toBe('grabbing');
    expect(monitorCursor('select', true)).toBe('grabbing');
  });
});
