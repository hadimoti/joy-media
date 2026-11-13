// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ColorGradeV2 } from '@joy-media/project-schema';
import { createIdentityColorGrade } from '@joy-media/project-schema';
import { ColorHsl } from './ColorHsl.js';
import { ColorCompareButton } from './ColorCompareButton.js';
import { colorGradePreview } from './color-grade-preview.js';
import { createColorEyedropperStore, type ColorEyedropperStore } from './color-eyedropper.js';
import { createColorGradeBypassStore } from './color-grade-bypass.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  colorGradePreview.set(undefined);
});

function Harness({
  onCommit,
  eyedropper,
}: {
  readonly onCommit: (next: ColorGradeV2) => void;
  readonly eyedropper: ColorEyedropperStore;
}) {
  const [draft, setDraft] = useState<ColorGradeV2>(() => createIdentityColorGrade());
  return (
    <ColorHsl
      draft={draft}
      onChange={setDraft}
      onCommit={(next) => {
        setDraft(next);
        onCommit(next);
      }}
      animationStateFor={() => 'none'}
      onToggleAnimation={() => undefined}
      canAnimate={true}
      scope="output"
      eyedropper={eyedropper}
    />
  );
}

function mount(onCommit: (next: ColorGradeV2) => void, eyedropper = createColorEyedropperStore()) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness onCommit={onCommit} eyedropper={eyedropper} />);
  });
  return eyedropper;
}

function band(id: string): HTMLDetailsElement {
  const element = container!.querySelector<HTMLDetailsElement>(`[data-hsl-band="${id}"]`);
  if (element === null) throw new Error(`no ${id} band`);
  return element;
}

function control(id: string, key: string): HTMLInputElement {
  return band(id).querySelector<HTMLInputElement>(`input[data-hsl-control="${key}"]`)!;
}

function numberBox(label: string): HTMLInputElement {
  return container!.querySelector<HTMLInputElement>(`input[aria-label="${label} value"]`)!;
}

/** Types a value the way a browser does, so React sees the change. */
function typeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function fire(target: Element, event: Event): void {
  act(() => {
    target.dispatchEvent(event);
  });
}

function status(): string {
  return container!.querySelector('[data-hsl-status]')?.textContent ?? '';
}

describe('ColorHsl bands', () => {
  it('gives every band Hue shift, Saturation, Luminance and Width with a number box, a chip and a reset', () => {
    mount(vi.fn());
    const red = band('red');
    for (const label of ['Red Hue shift', 'Red Saturation', 'Red Luminance', 'Red Width']) {
      expect(red.querySelector(`[data-property-row="${label}"]`)).not.toBeNull();
      expect(numberBox(label)).not.toBeNull();
    }
    expect(red.querySelector('[data-hsl-chip="red"]')).not.toBeNull();
    expect(red.textContent).toContain('Reset Red band');
    expect(container!.querySelectorAll('[data-hsl-band]')).toHaveLength(8);
  });

  it('previews a slider live and writes once when it is let go', () => {
    const onCommit = vi.fn();
    mount(onCommit);
    const saturation = control('green', 'saturation');
    typeValue(saturation, '-0.5');
    expect(onCommit).not.toHaveBeenCalled();
    expect(colorGradePreview.get()?.grade.hsl?.[3]?.saturation).toBe(-0.5);
    fire(saturation, new MouseEvent('pointerup', { bubbles: true }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect((onCommit.mock.calls[0]![0] as ColorGradeV2).hsl![3]!.saturation).toBe(-0.5);
    expect(colorGradePreview.get()).toBeUndefined();
  });

  it('takes a typed number: preview while typing, one write on Enter', () => {
    const onCommit = vi.fn();
    mount(onCommit);
    const box = numberBox('Blue Hue shift');
    fire(box, new FocusEvent('focusin', { bubbles: true }));
    typeValue(box, '30');
    expect(colorGradePreview.get()?.grade.hsl?.[5]?.hueShift).toBe(30);
    expect(onCommit).not.toHaveBeenCalled();
    fire(box, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect((onCommit.mock.calls[0]![0] as ColorGradeV2).hsl![5]!.hueShift).toBe(30);
  });

  it('keeps a typed number inside its range', () => {
    const onCommit = vi.fn();
    mount(onCommit);
    const box = numberBox('Red Width');
    typeValue(box, '500');
    fire(box, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect((onCommit.mock.calls[0]![0] as ColorGradeV2).hsl![0]!.hueWidth).toBe(180);
  });

  it('resets one band only', () => {
    const onCommit = vi.fn();
    mount(onCommit);
    typeValue(control('red', 'luminance'), '0.3');
    fire(control('red', 'luminance'), new MouseEvent('pointerup', { bubbles: true }));
    typeValue(control('cyan', 'luminance'), '0.2');
    fire(control('cyan', 'luminance'), new MouseEvent('pointerup', { bubbles: true }));
    const reset = [...band('red').querySelectorAll('button')].find(
      (button) => button.textContent === 'Reset Red band',
    )!;
    fire(reset, new MouseEvent('click', { bubbles: true }));
    const written = onCommit.mock.calls.at(-1)![0] as ColorGradeV2;
    expect(written.hsl![0]!.luminance).toBe(0);
    expect(written.hsl![4]!.luminance).toBe(0.2);
  });
});

describe('ColorHsl eyedropper', () => {
  function eyedropperButton(): HTMLButtonElement {
    return container!.querySelector<HTMLButtonElement>('[data-hsl-eyedropper]')!;
  }

  it('is a header button named "Pick a colour from the picture"', () => {
    mount(vi.fn());
    expect(eyedropperButton().title).toBe('Pick a colour from the picture');
    expect(eyedropperButton().getAttribute('aria-pressed')).toBe('false');
  });

  it('opens and highlights the nearest band and centres it on a picked green', () => {
    const onCommit = vi.fn();
    const store = mount(onCommit);
    fire(eyedropperButton(), new MouseEvent('click', { bubbles: true }));
    expect(store.get()).toBeDefined();
    expect(eyedropperButton().getAttribute('aria-pressed')).toBe('true');
    expect(status()).toContain('Click a colour in the Monitor');

    act(() => store.pick({ r: 0, g: 255, b: 0 }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect((onCommit.mock.calls[0]![0] as ColorGradeV2).hsl![3]!.hue).toBe(120);
    expect(band('green').open).toBe(true);
    expect(band('green').className).toContain('is-picked');
    expect(band('green').textContent).toContain('120° centre');
    expect(status()).toBe('Picked 120°: the Green band now centres on it.');
    expect(eyedropperButton().getAttribute('aria-pressed')).toBe('false');

    // The opened band's saturation can go straight to its minimum.
    typeValue(control('green', 'saturation'), '-1');
    fire(control('green', 'saturation'), new MouseEvent('pointerup', { bubbles: true }));
    expect((onCommit.mock.calls[1]![0] as ColorGradeV2).hsl![3]!.saturation).toBe(-1);
  });

  it('writes nothing for a grey pixel and says why', () => {
    const onCommit = vi.fn();
    const store = mount(onCommit);
    fire(eyedropperButton(), new MouseEvent('click', { bubbles: true }));
    act(() => store.pick({ r: 120, g: 120, b: 120 }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(status()).toBe('That pixel is grey: it has no hue to pick.');
  });

  it('cancels with Esc and with a second click', () => {
    const store = mount(vi.fn());
    fire(eyedropperButton(), new MouseEvent('click', { bubbles: true }));
    fire(window as unknown as Element, new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(store.get()).toBeUndefined();
    expect(status()).toBe('');
    fire(eyedropperButton(), new MouseEvent('click', { bubbles: true }));
    fire(eyedropperButton(), new MouseEvent('click', { bubbles: true }));
    expect(store.get()).toBeUndefined();
  });
});

describe('Hold to compare', () => {
  function mountButton(store = createColorGradeBypassStore()) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root!.render(<ColorCompareButton store={store} />);
    });
    return { store, button: container.querySelector<HTMLButtonElement>('[data-color-compare]')! };
  }

  it('takes the grade off while the pointer is held', () => {
    const { store, button } = mountButton();
    fire(button, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(store.get()).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fire(button, new MouseEvent('pointerup', { bubbles: true }));
    expect(store.get()).toBe(false);
  });

  it('works from the keyboard and lets go when the panel goes away', () => {
    const { store, button } = mountButton();
    fire(button, new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(store.get()).toBe(true);
    fire(button, new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    expect(store.get()).toBe(false);
    fire(button, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    act(() => root!.unmount());
    root = undefined;
    expect(store.get()).toBe(false);
  });
});
