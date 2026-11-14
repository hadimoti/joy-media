// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const desktop = vi.hoisted(() => ({
  host: true,
  minimize: vi.fn(async () => undefined),
  toggle: vi.fn(async () => true),
  close: vi.fn(async () => undefined),
  isMaximized: vi.fn(async () => false),
}));

vi.mock('./desktop-client.js', () => ({
  isDesktopHost: () => desktop.host,
  minimizeDesktopWindow: desktop.minimize,
  toggleMaximizeDesktopWindow: desktop.toggle,
  closeDesktopWindow: desktop.close,
  isDesktopWindowMaximized: desktop.isMaximized,
}));

import { WindowControls } from './WindowControls.js';

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount(): HTMLElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<WindowControls />));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  desktop.host = true;
  vi.clearAllMocks();
});

describe('WindowControls', () => {
  it('renders nothing in a browser', () => {
    desktop.host = false;
    expect(mount().querySelector('.window-controls')).toBeNull();
  });

  it('offers minimize, maximize and close in the desktop app and calls the host', async () => {
    const view = mount();
    await act(async () => undefined);
    const button = (label: string) =>
      view.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button('Minimize window')).not.toBeNull();
    expect(button('Maximize window')).not.toBeNull();
    expect(button('Close window')).not.toBeNull();

    await act(async () => button('Minimize window')?.click());
    expect(desktop.minimize).toHaveBeenCalledTimes(1);
    await act(async () => button('Maximize window')?.click());
    expect(desktop.toggle).toHaveBeenCalledTimes(1);
    // After the host reports maximized, the control offers Restore.
    expect(button('Restore window')).not.toBeNull();
    await act(async () => button('Close window')?.click());
    expect(desktop.close).toHaveBeenCalledTimes(1);
  });
});
