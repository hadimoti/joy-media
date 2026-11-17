// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDialogHost } from './AppDialogs.js';
import { AssetLibraryPanel } from './AssetLibraryPanel.js';
import type { BrowserAsset } from './control-plane-client.js';
import type { DesktopJoyBridge } from './desktop-client.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const asset: BrowserAsset = {
  id: `joylib-${'a'.repeat(64)}`,
  projectId: 'project-1',
  kind: 'image',
  displayName: 'unused.png',
  sha256: 'a'.repeat(64),
  bytes: 3,
  descriptor: { mimeType: 'image/png' },
  createdAt: 1,
  cloudBacked: false,
};

const storage = {
  getItem: (): string | null => null,
  setItem: (): void => undefined,
  removeItem: (): void => undefined,
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let restoreBridge: (() => void) | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  restoreBridge?.();
  restoreBridge = undefined;
  vi.restoreAllMocks();
});

describe('AssetLibraryPanel bulk deletion', () => {
  it('waits for the app confirmation before removing and refreshing the selected asset', async () => {
    let catalog: readonly BrowserAsset[] = [asset];
    const removeEntry = vi.fn(async () => {
      catalog = [];
      return { removed: true };
    });
    const priorBridge = Object.getOwnPropertyDescriptor(window, 'joyDesktop');
    const bridge: DesktopJoyBridge = {
      channels: [],
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'desktop.asset-library.get-catalog') return { assets: catalog };
        if (channel === 'desktop.asset-library.remove-entry') return removeEntry();
        return undefined;
      }),
    };
    Object.defineProperty(window, 'joyDesktop', {
      value: bridge,
      configurable: true,
      writable: true,
    });
    restoreBridge = () => {
      if (priorBridge === undefined) Reflect.deleteProperty(window, 'joyDesktop');
      else Object.defineProperty(window, 'joyDesktop', priorBridge);
    };

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <>
          <AssetLibraryPanel projectId="project-1" storage={storage} />
          <AppDialogHost />
        </>,
      );
      await Promise.resolve();
    });

    const card = container.querySelector('.asset-card');
    expect(card?.textContent).toContain(asset.displayName);
    const checkbox = container.querySelector<HTMLInputElement>(
      `input[aria-label="Select ${asset.displayName}"]`,
    );
    expect(checkbox).not.toBeNull();
    await act(async () => {
      checkbox!.click();
    });
    await act(async () => {
      container
        ?.querySelector<HTMLButtonElement>('button[aria-label="Delete selected assets"]')
        ?.click();
      await Promise.resolve();
    });

    expect(removeEntry).not.toHaveBeenCalled();
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('Delete 1 selected media item(s) from the catalog?');
    await act(async () => {
      Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        .find((button) => button.textContent === 'Delete')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(removeEntry).toHaveBeenCalledOnce();
    expect(container.querySelector('.asset-card')).toBeNull();
    expect(container.textContent).toContain('Deleted 1 of 1 selected media items');
  });
});
