import { renderToStaticMarkup } from 'react-dom/server';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  ColorPropertyControl,
  createTransientControlAdapter,
  NumericPropertyControl,
  SelectPropertyControl,
  SliderPropertyControl,
  SwitchPropertyControl,
} from './PropertyControlAdapters.js';
import { useNumberScrub } from './useNumberScrub.js';
import {
  TransientPropertyInteraction,
  type PropertyInteractionCommit,
} from '../property-interaction.js';

function createHarness<T>(initial: T) {
  let value = initial;
  const commit = vi.fn<(change: PropertyInteractionCommit<T>) => void>();
  const interaction = new TransientPropertyInteraction<T>({
    read: () => value,
    preview: (next) => {
      value = next;
    },
    restore: (next) => {
      value = next;
    },
    commit,
  });
  return {
    interaction,
    commit,
    get value() {
      return value;
    },
  };
}

function pointer(x: number, currentTarget: HTMLElement, pointerId = 1, button = 0) {
  return {
    button,
    isPrimary: true,
    pointerId,
    clientX: x,
    currentTarget,
    preventDefault: vi.fn(),
  } as unknown as PointerEvent<HTMLElement>;
}

describe('property control adapters', () => {
  it('scrubs from the gesture start, clamps values, and commits once', () => {
    const harness = createHarness(0.2);
    const adapter = createTransientControlAdapter(harness.interaction, 'Opacity');
    const target = { setPointerCapture: vi.fn() } as unknown as HTMLElement;
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setTimeout: vi.fn(),
    });
    let bindings!: ReturnType<typeof useNumberScrub>;
    function Probe() {
      bindings = useNumberScrub({ value: harness.value, adapter, min: 0, max: 1, step: 0.1 });
      return null;
    }
    renderToStaticMarkup(<Probe />);
    bindings.onPointerDown(pointer(10, target));
    const acceptedMove = pointer(14, target);
    bindings.onPointerMove(acceptedMove);
    expect(harness.value).toBe(0.3);
    bindings.onPointerMove(pointer(54, target));
    bindings.onPointerUp(pointer(54, target));
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    bindings.onClickCapture(click as unknown as MouseEvent<HTMLElement>);
    expect(harness.value).toBe(1);
    expect(harness.commit).toHaveBeenCalledOnce();
    expect(target.setPointerCapture).toHaveBeenCalledWith(1);
    expect(acceptedMove.preventDefault).toHaveBeenCalledOnce();
    expect(click.preventDefault).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('ignores right clicks and sub-threshold movement without suppressing the click', () => {
    const harness = createHarness(4);
    const adapter = createTransientControlAdapter(harness.interaction, 'Scale');
    const target = { setPointerCapture: vi.fn() } as unknown as HTMLElement;
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setTimeout: vi.fn(),
    });
    let bindings!: ReturnType<typeof useNumberScrub>;
    function Probe() {
      bindings = useNumberScrub({ value: harness.value, adapter, step: 1 });
      return null;
    }
    renderToStaticMarkup(<Probe />);
    bindings.onPointerDown(pointer(0, target, 1, 2));
    bindings.onPointerMove(pointer(20, target));
    bindings.onPointerDown(pointer(0, target, 2));
    bindings.onPointerMove(pointer(3, target, 2));
    bindings.onPointerUp(pointer(3, target, 2));

    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    bindings.onClickCapture(click as unknown as MouseEvent<HTMLElement>);
    expect(harness.value).toBe(4);
    expect(harness.commit).not.toHaveBeenCalled();
    expect(target.setPointerCapture).not.toHaveBeenCalled();
    expect(click.preventDefault).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('restores the previous value on cancel, lost capture, Escape, and window blur', () => {
    const harness = createHarness(5);
    const adapter = createTransientControlAdapter(harness.interaction, 'Scale');
    const target = { setPointerCapture: vi.fn() } as unknown as HTMLElement;
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal('window', {
      addEventListener: vi.fn((name: string, listener: EventListener) =>
        listeners.set(name, listener),
      ),
      removeEventListener: vi.fn((name: string) => listeners.delete(name)),
      setTimeout: vi.fn(),
    });
    let bindings!: ReturnType<typeof useNumberScrub>;
    function Probe() {
      bindings = useNumberScrub({ value: harness.value, adapter, step: 0.5 });
      return null;
    }
    renderToStaticMarkup(<Probe />);
    const beginDrag = (pointerId: number) => {
      bindings.onPointerDown(pointer(0, target, pointerId));
      bindings.onPointerMove(pointer(8, target, pointerId));
      expect(harness.value).toBe(6);
    };

    beginDrag(1);
    bindings.onPointerCancel(pointer(8, target, 1));
    expect(harness.value).toBe(5);
    beginDrag(2);
    bindings.onLostPointerCapture(pointer(8, target, 2));
    expect(harness.value).toBe(5);
    beginDrag(3);
    const escape = { key: 'Escape', preventDefault: vi.fn() };
    expect(bindings.onKeyDown(escape as unknown as KeyboardEvent<HTMLElement>)).toBe(true);
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(harness.value).toBe(5);
    beginDrag(4);
    listeners.get('blur')?.(new Event('blur'));
    expect(harness.value).toBe(5);
    expect(harness.commit).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('releases pointer capture and clears an interrupted gesture on Escape and window blur', () => {
    const harness = createHarness(5);
    const adapter = createTransientControlAdapter(harness.interaction, 'Scale');
    let capturedPointer: number | undefined;
    const target = {
      setPointerCapture: vi.fn((pointerId: number) => {
        capturedPointer = pointerId;
      }),
      hasPointerCapture: vi.fn((pointerId: number) => capturedPointer === pointerId),
      releasePointerCapture: vi.fn((pointerId: number) => {
        if (capturedPointer === pointerId) capturedPointer = undefined;
      }),
    } as unknown as HTMLElement;
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal('window', {
      addEventListener: vi.fn((name: string, listener: EventListener) =>
        listeners.set(name, listener),
      ),
      removeEventListener: vi.fn((name: string) => listeners.delete(name)),
      setTimeout: vi.fn(),
    });
    let bindings!: ReturnType<typeof useNumberScrub>;
    function Probe() {
      bindings = useNumberScrub({ value: harness.value, adapter, step: 0.5 });
      return null;
    }
    renderToStaticMarkup(<Probe />);

    bindings.onPointerDown(pointer(0, target, 1));
    bindings.onPointerMove(pointer(8, target, 1));
    expect(capturedPointer).toBe(1);
    bindings.onKeyDown({ key: 'Escape', preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLElement>);
    bindings.onPointerUp(pointer(8, target, 1));
    expect(capturedPointer).toBeUndefined();
    expect(target.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(harness.value).toBe(5);
    expect(harness.commit).not.toHaveBeenCalled();

    bindings.onPointerDown(pointer(0, target, 2));
    bindings.onPointerMove(pointer(8, target, 2));
    expect(capturedPointer).toBe(2);
    listeners.get('blur')?.(new Event('blur'));
    bindings.onPointerUp(pointer(8, target, 2));
    expect(capturedPointer).toBeUndefined();
    expect(target.releasePointerCapture).toHaveBeenCalledWith(2);
    expect(harness.value).toBe(5);
    expect(harness.commit).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('does not start pointer gestures when disabled', () => {
    const harness = createHarness(2);
    const adapter = createTransientControlAdapter(harness.interaction, 'Scale');
    const target = { setPointerCapture: vi.fn() } as unknown as HTMLElement;
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setTimeout: vi.fn(),
    });
    let bindings!: ReturnType<typeof useNumberScrub>;
    function Probe() {
      bindings = useNumberScrub({ value: harness.value, adapter, disabled: true });
      return null;
    }
    renderToStaticMarkup(<Probe />);
    bindings.onPointerDown(pointer(0, target));
    bindings.onPointerMove(pointer(8, target));
    bindings.onPointerUp(pointer(8, target));
    expect(bindings.cursorStyle).toBeUndefined();
    expect(harness.value).toBe(2);
    expect(harness.commit).not.toHaveBeenCalled();
    expect(target.setPointerCapture).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('applies the supplied numeric normalizer to scrub values', () => {
    const harness = createHarness(0.2);
    const adapter = createTransientControlAdapter(harness.interaction, 'Opacity');
    const target = { setPointerCapture: vi.fn() } as unknown as HTMLElement;
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setTimeout: vi.fn(),
    });
    let bindings!: ReturnType<typeof useNumberScrub>;
    function Probe() {
      bindings = useNumberScrub({
        value: harness.value,
        adapter,
        step: 0.1,
        normalize: (next) => Math.round(next * 2) / 2,
      });
      return null;
    }
    renderToStaticMarkup(<Probe />);
    bindings.onPointerDown(pointer(0, target));
    bindings.onPointerMove(pointer(4, target));
    bindings.onPointerUp(pointer(4, target));
    expect(harness.value).toBe(0.5);
    expect(harness.commit).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
  it('makes a long slider gesture one durable commit', () => {
    const harness = createHarness(0);
    const adapter = createTransientControlAdapter(harness.interaction, 'Adjust opacity');

    adapter.begin();
    adapter.preview(0.25);
    adapter.preview(0.5);
    adapter.preview(0.75);
    adapter.commit();

    expect(harness.commit).toHaveBeenCalledOnce();
    expect(harness.commit).toHaveBeenCalledWith({
      label: 'Adjust opacity',
      previous: 0,
      next: 0.75,
    });
  });

  it('does not commit a keyboard draft twice when blur follows Enter', () => {
    const harness = createHarness(1);
    const adapter = createTransientControlAdapter(harness.interaction, 'Opacity');
    adapter.preview(0.75);
    adapter.commit();
    adapter.commit();
    expect(harness.commit).toHaveBeenCalledOnce();
    expect(harness.commit).toHaveBeenCalledWith({ label: 'Opacity', previous: 1, next: 0.75 });
  });

  it('cancels numeric, discrete, and compound gestures without a history command', () => {
    const numeric = createHarness(10);
    const discrete = createHarness<'linear' | 'hold'>('linear');
    const compound = createHarness({ x: 0, y: 0, linked: true });

    const numericAdapter = createTransientControlAdapter(numeric.interaction, 'Position X');
    const discreteAdapter = createTransientControlAdapter(discrete.interaction, 'Interpolation');
    const compoundAdapter = createTransientControlAdapter(compound.interaction, 'Position');

    numericAdapter.preview(120);
    numericAdapter.cancel();
    discreteAdapter.preview('hold');
    discreteAdapter.cancel();
    compoundAdapter.preview({ x: 120, y: 80, linked: true });
    compoundAdapter.cancel();

    expect(numeric.value).toBe(10);
    expect(discrete.value).toBe('linear');
    expect(compound.value).toEqual({ x: 0, y: 0, linked: true });
    expect(numeric.commit).not.toHaveBeenCalled();
    expect(discrete.commit).not.toHaveBeenCalled();
    expect(compound.commit).not.toHaveBeenCalled();
  });

  it('renders native controls with named accessible semantics', () => {
    const scalar = createTransientControlAdapter(createHarness(1).interaction, 'Adjust gain');
    const color = createTransientControlAdapter(createHarness('#ffcc00').interaction, 'Set tint');
    const mode = createTransientControlAdapter(
      createHarness<'normal' | 'screen'>('normal').interaction,
      'Set blend mode',
    );
    const enabled = createTransientControlAdapter(
      createHarness(true).interaction,
      'Toggle enabled',
    );
    const markup = renderToStaticMarkup(
      <>
        <NumericPropertyControl id="gain" value={1} adapter={scalar} ariaLabel="Gain" />
        <SliderPropertyControl
          value={1}
          min={0}
          max={2}
          step={0.1}
          adapter={scalar}
          ariaLabel="Gain"
        />
        <ColorPropertyControl id="tint" value="#ffcc00" adapter={color} ariaLabel="Tint" />
        <SelectPropertyControl
          id="blend"
          value="normal"
          adapter={mode}
          ariaLabel="Blend mode"
          options={[
            { value: 'normal', label: 'Normal' },
            { value: 'screen', label: 'Screen' },
          ]}
        />
        <SwitchPropertyControl checked adapter={enabled} ariaLabel="Enabled" />
      </>,
    );

    expect(markup).toContain('id="gain"');
    expect(markup).toContain('type="range"');
    expect(markup).toContain('type="color"');
    expect(markup).toContain('aria-label="Blend mode"');
    expect(markup).toContain('role="switch"');
  });
});
