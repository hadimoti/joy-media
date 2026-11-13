// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAsset } from './control-plane-client.js';
import { importDroppedMediaFiles, type DroppedMediaImportBatchResult } from './media-import.js';
import type {
  DesktopDroppedFileBatch,
  DesktopDroppedFileTicket,
  DesktopJoyBridge,
} from './desktop-client.js';
import { AssetLibraryPanel } from './AssetLibraryPanel.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const storage = {
  getItem: (): string | null => null,
  setItem: (): void => undefined,
  removeItem: (): void => undefined,
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let restoreBridge: (() => void) | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ticket(file: File, sourceIndex: number): DesktopDroppedFileTicket {
  return {
    kind: 'local-file',
    id: `drop-ticket-${sourceIndex + 1}`,
    displayName: file.name,
    mediaKind: 'image',
    mimeType: 'image/png',
    sourceIndex,
  };
}

function installDroppedFileBridge(
  batch: DesktopDroppedFileBatch,
  catalogAssets: () => readonly BrowserAsset[] = () => [],
) {
  const priorBridge = Object.getOwnPropertyDescriptor(window, 'joyDesktop');
  const bridge: DesktopJoyBridge = {
    channels: [],
    invoke: vi.fn(async (channel: string) =>
      channel === 'desktop.asset-library.get-catalog' ? { assets: catalogAssets() } : undefined,
    ),
    importDroppedFiles: vi.fn(async () => batch),
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
  return bridge;
}

function importClient(
  files: readonly File[],
  importDroppedAsset: (file: File, ticket: DesktopDroppedFileTicket) => Promise<BrowserAsset>,
) {
  return {
    ensureProject: vi.fn(async () => undefined),
    importDroppedAsset: vi.fn(async (_projectId: string, ticketId: string) => {
      const found = files
        .map((file, index) => ({ file, ticket: ticket(file, index) }))
        .find((entry) => entry.ticket.id === ticketId);
      if (found === undefined) throw new Error(`Unknown ticket ${ticketId}`);
      return importDroppedAsset(found.file, found.ticket);
    }),
    cancelDroppedImport: vi.fn(async () => undefined),
  };
}

function importedAsset(file: File, item: DesktopDroppedFileTicket): BrowserAsset {
  return {
    id: `asset-${item.sourceIndex + 1}`,
    kind: item.mediaKind,
    displayName: file.name,
    sha256: 'a'.repeat(64),
    bytes: file.size,
    descriptor: { mimeType: item.mimeType },
    projectId: 'project-1',
    createdAt: 1,
    cloudBacked: true,
  };
}

async function renderPanel(
  props: {
    readonly onImportFiles?: (files: readonly File[]) => void;
    readonly droppedImportProgress?: {
      readonly fileName: string;
      readonly current: number;
      readonly total: number;
      readonly percentage: number;
      readonly cancelling: boolean;
    };
    readonly onCancelDroppedImport?: () => void;
  } = {},
): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<AssetLibraryPanel projectId="project-1" storage={storage} {...props} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

function dispatchDrop(rendered: HTMLElement, files: readonly File[]): void {
  const dropZone = rendered.querySelector<HTMLElement>('.asset-library-drop-zone');
  if (dropZone === null) throw new Error('Expected the asset library drop zone');
  const transfer = { files, types: ['Files'], dropEffect: 'none' };
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: transfer });
  dropZone.dispatchEvent(drop);
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  restoreBridge?.();
  vi.restoreAllMocks();
});

describe('the Media panel empty state (T-D05)', () => {
  it('says one thing and offers one way in', async () => {
    const rendered = await renderPanel();

    const dropZone = rendered.querySelector<HTMLElement>('.asset-library-drop-zone');
    expect(dropZone, 'the empty library is a drop zone').not.toBeNull();
    expect(dropZone?.textContent).toContain('Drop video, audio or images here');

    const buttons = [
      ...rendered.querySelectorAll<HTMLButtonElement>('.asset-library-empty button'),
    ];
    expect(buttons, 'the empty state offers exactly one button').toHaveLength(1);
    expect(buttons[0]?.textContent?.trim()).toBe('Import');
    expect(buttons[0]?.className).toContain('button-primary');

    expect(rendered.textContent).not.toContain('No library assets match the current filters.');
    expect(rendered.textContent).not.toContain('Failed to load media catalog.');

    await act(async () => buttons[0]?.click());
    expect(rendered.querySelector('[role="dialog"][aria-label="Import media"]')).not.toBeNull();
  });

  it('routes one dropped file through the desktop import bridge', async () => {
    const file = new File(['one'], 'one.png', { type: 'image/png' });
    const batch = { tickets: [ticket(file, 0)], folderDepth: 1 as const, folderCount: 0 };
    const bridge = installDroppedFileBridge(batch);
    const client = importClient([file], async (source, item) => importedAsset(source, item));
    const importedAssets: BrowserAsset[] = [];
    const completed = deferred<DroppedMediaImportBatchResult | undefined>();
    const rendered = await renderPanel({
      onImportFiles: (files) => {
        void importDroppedMediaFiles({
          projectId: 'project-1',
          projectTitle: 'Project',
          files,
          client,
          originalAssetCache: { putFromVerifiedDesktopImport: vi.fn(async () => undefined) },
          onImported: (asset) => {
            importedAssets.push(asset);
          },
        }).then(completed.resolve);
      },
    });

    await act(async () => {
      dispatchDrop(rendered, [file]);
      await Promise.resolve();
    });
    const result = await completed.promise;

    expect(bridge.importDroppedFiles).toHaveBeenCalledWith([file]);
    expect(client.importDroppedAsset).toHaveBeenCalledTimes(1);
    expect(importedAssets.map((asset) => asset.displayName)).toEqual(['one.png']);
    expect(result?.assets).toHaveLength(1);
  });

  it('refreshes the Media list after a drop so the empty state disappears', async () => {
    const file = new File(['one'], 'one.png', { type: 'image/png' });
    const batch = { tickets: [ticket(file, 0)], folderDepth: 1 as const, folderCount: 0 };
    let catalog: readonly BrowserAsset[] = [];
    let catalogReads = 0;
    installDroppedFileBridge(batch, () => {
      catalogReads += 1;
      return catalog;
    });
    const client = importClient([file], async (source, item) => importedAsset(source, item));
    let importFinished: Promise<void> | undefined;
    const rendered = await renderPanel({
      onImportFiles: (files) => {
        importFinished = (async () => {
          const result = await importDroppedMediaFiles({
            projectId: 'project-1',
            projectTitle: 'Project',
            files,
            client,
            originalAssetCache: { putFromVerifiedDesktopImport: vi.fn(async () => undefined) },
          });
          catalog = result?.assets ?? [];
        })();
        return importFinished;
      },
    });
    const initialCatalogReads = catalogReads;

    expect(rendered.querySelector('.asset-library-empty')).not.toBeNull();
    await act(async () => {
      dispatchDrop(rendered, [file]);
      await importFinished;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(catalogReads).toBeGreaterThan(initialCatalogReads);
    expect(rendered.textContent).toContain('one.png');
    expect(rendered.querySelector('.asset-library-empty')).toBeNull();
  });

  it('routes every dropped file through the desktop import bridge', async () => {
    const files = [
      new File(['one'], 'one.png', { type: 'image/png' }),
      new File(['two'], 'two.png', { type: 'image/png' }),
    ];
    const batch = {
      tickets: files.map(ticket),
      folderDepth: 1 as const,
      folderCount: 0,
    };
    const bridge = installDroppedFileBridge(batch);
    const client = importClient(files, async (source, item) => importedAsset(source, item));
    const completed = deferred<DroppedMediaImportBatchResult | undefined>();
    const rendered = await renderPanel({
      onImportFiles: (droppedFiles) => {
        void importDroppedMediaFiles({
          projectId: 'project-1',
          projectTitle: 'Project',
          files: droppedFiles,
          client,
          originalAssetCache: { putFromVerifiedDesktopImport: vi.fn(async () => undefined) },
        }).then(completed.resolve);
      },
    });

    await act(async () => {
      dispatchDrop(rendered, files);
      await Promise.resolve();
    });
    const result = await completed.promise;

    expect(bridge.importDroppedFiles).toHaveBeenCalledWith(files);
    expect(client.importDroppedAsset).toHaveBeenCalledTimes(2);
    expect(result?.assets.map((asset) => asset.displayName)).toEqual(['one.png', 'two.png']);
  });

  it('returns the bridge folder and skipped-file report to the Media drop handler', async () => {
    const file = new File(['one'], 'one.png', { type: 'image/png' });
    const batch: DesktopDroppedFileBatch = {
      tickets: [ticket(file, 0)],
      folderDepth: 1,
      folderCount: 1,
      skippedMessage: 'Skipped 2 unsupported files.',
    };
    installDroppedFileBridge(batch);
    const client = importClient([file], async (source, item) => importedAsset(source, item));
    const completed = deferred<DroppedMediaImportBatchResult | undefined>();
    const rendered = await renderPanel({
      onImportFiles: (files) => {
        void importDroppedMediaFiles({
          projectId: 'project-1',
          projectTitle: 'Project',
          files,
          client,
          originalAssetCache: { putFromVerifiedDesktopImport: vi.fn(async () => undefined) },
        }).then(completed.resolve);
      },
    });

    await act(async () => {
      dispatchDrop(rendered, [file]);
      await Promise.resolve();
    });
    const result = await completed.promise;

    expect(result).toMatchObject({
      folderDepth: 1,
      folderCount: 1,
      skippedMessage: 'Skipped 2 unsupported files.',
    });
  });

  it('shows the shared progress strip and lets the user cancel a bridge import', async () => {
    const file = new File(['one'], 'one.png', { type: 'image/png' });
    const item = ticket(file, 0);
    const batch = { tickets: [item], folderDepth: 1 as const, folderCount: 0 };
    installDroppedFileBridge(batch);
    const controller = new AbortController();
    const started = deferred<void>();
    const finishImport = deferred<BrowserAsset>();
    const completed = deferred<DroppedMediaImportBatchResult | undefined>();
    const client = importClient([file], async () => {
      started.resolve();
      return finishImport.promise;
    });
    const onCancelDroppedImport = vi.fn(() => controller.abort());
    const rendered = await renderPanel({
      droppedImportProgress: {
        fileName: file.name,
        current: 1,
        total: 1,
        percentage: 25,
        cancelling: false,
      },
      onCancelDroppedImport,
      onImportFiles: (files) => {
        void importDroppedMediaFiles({
          projectId: 'project-1',
          projectTitle: 'Project',
          files,
          signal: controller.signal,
          client,
          originalAssetCache: { putFromVerifiedDesktopImport: vi.fn(async () => undefined) },
        }).then(completed.resolve);
      },
    });

    expect(rendered.querySelector('.dropped-import-progress')).not.toBeNull();
    await act(async () => {
      dispatchDrop(rendered, [file]);
      await Promise.resolve();
    });
    await started.promise;
    const cancel = [...rendered.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Cancel',
    );
    if (cancel === undefined) throw new Error('Expected the dropped import Cancel button');
    await act(async () => cancel.click());
    finishImport.resolve(importedAsset(file, item));
    const result = await completed.promise;

    expect(onCancelDroppedImport).toHaveBeenCalledOnce();
    expect(client.cancelDroppedImport).toHaveBeenCalledWith(item.id);
    expect(result?.cancelled).toBe(true);
  });

  it('hands dropped files to the timeline-compatible web fallback when the bridge is absent', async () => {
    const files = [
      new File(['one'], 'one.png', { type: 'image/png' }),
      new File(['two'], 'two.png', { type: 'image/png' }),
    ];
    const fallbackFiles: File[] = [];
    const completed = deferred<void>();
    const rendered = await renderPanel({
      onImportFiles: (droppedFiles) => {
        void importDroppedMediaFiles({
          projectId: 'project-1',
          projectTitle: 'Project',
          files: droppedFiles,
          client: importClient(droppedFiles, async (source, item) => importedAsset(source, item)),
          originalAssetCache: { putFromVerifiedDesktopImport: vi.fn(async () => undefined) },
        }).then((result) => {
          if (result === undefined) fallbackFiles.push(...droppedFiles);
          completed.resolve();
        });
      },
    });

    await act(async () => {
      dispatchDrop(rendered, files);
      await Promise.resolve();
    });
    await completed.promise;

    expect(fallbackFiles).toEqual(files);
  });
});
