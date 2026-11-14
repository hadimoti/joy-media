// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ColorSwatchPicker } from './ColorPickerPopover.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

async function mount(onChange: (hex: string) => void, value = '#ff0000'): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<ColorSwatchPicker value={value} onChange={onChange} label="Fill" />);
  });
}

const swatch = (): HTMLButtonElement =>
  container?.querySelector<HTMLButtonElement>('button.joy-color-swatch') as HTMLButtonElement;
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]');

async function openPicker(): Promise<void> {
  await act(async () => swatch().click());
}

function setInputValue(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ColorSwatchPicker', () => {
  it('opens on click, names itself and fills the swatch', async () => {
    await mount(() => undefined);
    expect(swatch().getAttribute('aria-label')).toBe('Fill');
    expect(swatch().getAttribute('aria-haspopup')).toBe('dialog');
    expect(swatch().getAttribute('aria-expanded')).toBe('false');
    expect(swatch().style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect(dialog()).toBeNull();

    await openPicker();
    expect(dialog()?.getAttribute('aria-label')).toBe('Fill picker');
    expect(swatch().getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector<HTMLInputElement>('.joy-color-hex')?.value).toBe('#ff0000');
  });

  it('closes when the swatch is clicked again', async () => {
    await mount(() => undefined);
    await openPicker();
    await openPicker();
    expect(dialog()).toBeNull();
  });

  it('closes on Escape and returns focus to the swatch', async () => {
    await mount(() => undefined);
    await openPicker();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(swatch());
  });

  it('closes on a press outside', async () => {
    await mount(() => undefined);
    await openPicker();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(dialog()).toBeNull();
  });

  it('commits a valid hex on Enter in lowercase', async () => {
    const onChange = vi.fn();
    await mount(onChange);
    await openPicker();
    const input = document.querySelector<HTMLInputElement>('.joy-color-hex') as HTMLInputElement;
    await act(async () => input.focus());
    await act(async () => setInputValue(input, 'ABC'));
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('#aabbcc');
  });

  it('does not commit an invalid hex and reverts the text', async () => {
    const onChange = vi.fn();
    await mount(onChange);
    await openPicker();
    const input = document.querySelector<HTMLInputElement>('.joy-color-hex') as HTMLInputElement;
    await act(async () => input.focus());
    await act(async () => setInputValue(input, 'zzz'));
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('#ff0000');
  });

  it('calls onChange while dragging on the square', async () => {
    const onChange = vi.fn();
    await mount(onChange);
    await openPicker();
    const square = document.querySelector<HTMLElement>('.joy-color-square') as HTMLElement;
    vi.spyOn(square, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 200,
      bottom: 100,
      width: 200,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const fire = (type: string, clientX: number, clientY: number): void => {
      square.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY }),
      );
    };
    await act(async () => fire('pointerdown', 0, 0));
    // Top-left corner: no saturation, full value.
    expect(onChange).toHaveBeenLastCalledWith('#ffffff');
    await act(async () => fire('pointermove', 200, 100));
    await act(async () => fire('pointerup', 200, 100));
    // Bottom-right corner: full saturation, no value.
    expect(onChange).toHaveBeenLastCalledWith('#000000');
    await act(async () => fire('pointermove', 0, 0));
    expect(onChange).toHaveBeenLastCalledWith('#000000');
  });

  it('moves the hue and square by keyboard', async () => {
    const onChange = vi.fn();
    await mount(onChange);
    await openPicker();
    const bar = document.querySelector<HTMLElement>('.joy-color-hue') as HTMLElement;
    await act(async () => {
      bar.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
      );
    });
    expect(onChange).toHaveBeenLastCalledWith('#ff2a00');
  });

  it('keeps the hue when saturation drops to zero', async () => {
    const onChange = vi.fn();
    await mount(onChange, '#0000ff');
    await openPicker();
    const square = document.querySelector<HTMLElement>('.joy-color-square') as HTMLElement;
    await act(async () => {
      for (let step = 0; step < 100; step += 1) {
        square.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      }
    });
    expect(onChange).toHaveBeenLastCalledWith('#ffffff');
    const bar = document.querySelector<HTMLElement>('.joy-color-hue') as HTMLElement;
    expect(bar.getAttribute('aria-valuenow')).toBe('240');
  });

  it('does not open when disabled', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ColorSwatchPicker value="#123456" onChange={() => undefined} label="Fill" disabled />,
      );
    });
    await act(async () => swatch().click());
    expect(dialog()).toBeNull();
  });
});
