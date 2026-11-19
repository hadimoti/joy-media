// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASSET_LIBRARY_CHANGED_EVENT, AssetLibraryPanel } from './AssetLibraryPanel.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const storage = {
  getItem: (): string | null => null,
  setItem: (): void => undefined,
  removeItem: (): void => undefined,
};

const CATALOG_CHANNEL = 'desktop.asset-library.get-catalog';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let restoreBridge: (() => void) | undefined;

/** A desktop bridge whose catalog is empty. The returned mock counts the catalog reads. */
function installCatalogBridge() {
  const priorBridge = Object.getOwnPropertyDescriptor(window, 'joyDesktop');
  const invoke = vi.fn(async (channel: string) =>
    channel === CATALOG_CHANNEL ? { assets: [] } : undefined,
  );
  const bridge = {
    channels: [],
    invoke,
    importDroppedFiles: vi.fn(async () => undefined),
    onDroppedImportProgress: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, 'joyDesktop', {
    value: bridge,
    configurable: true,
    writable: true,
  });
  restoreBridge = () => {
    if (priorBridge === undefined) Reflect.deleteProperty(window, 'joyDesktop');
    else Object.defineProperty(window, 'joyDesktop', priorBridge);
    restoreBridge = undefined;
  };
  return invoke;
}

function catalogReads(invoke: ReturnType<typeof installCatalogBridge>): number {
  return invoke.mock.calls.filter(([channel]) => channel === CATALOG_CHANNEL).length;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function mountRoot(): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
}

async function renderPanel(): Promise<void> {
  await act(async () => {
    root?.render(<AssetLibraryPanel projectId="project-1" storage={storage} />);
    await flush();
  });
}

async function announceLibraryChange(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event(ASSET_LIBRARY_CHANGED_EVENT));
    await flush();
  });
}

describe('AssetLibraryPanel reloads after the library changes outside it (defect 206)', () => {
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    restoreBridge?.();
  });

  it('reloads the catalog when the editor announces a library change', async () => {
    const invoke = installCatalogBridge();
    mountRoot();
    await renderPanel();
    const readsAtMount = catalogReads(invoke);
    await announceLibraryChange();
    expect(catalogReads(invoke)).toBe(readsAtMount + 1);
  });

  it('stops listening once the panel is gone', async () => {
    const invoke = installCatalogBridge();
    mountRoot();
    await renderPanel();
    act(() => root?.unmount());
    root = undefined;
    const readsBeforeAnnouncement = catalogReads(invoke);
    await announceLibraryChange();
    expect(catalogReads(invoke)).toBe(readsBeforeAnnouncement);
  });
});
