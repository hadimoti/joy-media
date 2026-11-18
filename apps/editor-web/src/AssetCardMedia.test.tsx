// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetCardMedia } from './AssetLibraryPanel.js';
import type { BrowserAsset } from './control-plane-client.js';
import type { AuthorizedDerivativeResolver } from './asset-resolver.js';
import type { OpfsOriginalAssetCache } from './opfs-original-asset-cache.js';
import type { DesktopJoyBridge } from './desktop-client.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const asset: BrowserAsset = {
  id: 'joylib-image-1',
  projectId: 'project-1',
  kind: 'image',
  displayName: 'Cover',
  sha256: 'a'.repeat(64),
  bytes: 100,
  descriptor: { mimeType: 'image/png' },
  createdAt: 1,
  cloudBacked: false,
  relativePath: 'images/Cover Art.png',
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let restoreBridge: (() => void) | undefined;

const resolver = {
  resolve: async () => ({ state: 'unavailable' as const }),
} as unknown as AuthorizedDerivativeResolver;
const originalCache = { get: async () => undefined } as unknown as OpfsOriginalAssetCache;

beforeEach(() => vi.stubGlobal('IntersectionObserver', undefined));

function setBridge(bridge: DesktopJoyBridge | undefined): void {
  const priorBridge = Object.getOwnPropertyDescriptor(window, 'joyDesktop');
  if (bridge === undefined) Reflect.deleteProperty(window, 'joyDesktop');
  else {
    Object.defineProperty(window, 'joyDesktop', {
      value: bridge,
      configurable: true,
      writable: true,
    });
  }
  restoreBridge = () => {
    if (priorBridge === undefined) Reflect.deleteProperty(window, 'joyDesktop');
    else Object.defineProperty(window, 'joyDesktop', priorBridge);
  };
}

async function mountAssetCardMedia(): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(
      <AssetCardMedia
        asset={asset}
        derivatives={[]}
        projectId="project-1"
        resolverPromise={Promise.resolve(resolver)}
        originalCachePromise={Promise.resolve(originalCache)}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  restoreBridge?.();
  restoreBridge = undefined;
  vi.unstubAllGlobals();
});

describe('AssetCardMedia library preview', () => {
  it('shows a desktop library image and returns to its placeholder on error', async () => {
    setBridge({ channels: [], invoke: async () => undefined });
    await mountAssetCardMedia();

    const mediaButton = container?.querySelector<HTMLButtonElement>('[data-source="library"]');
    const image = mediaButton?.querySelector<HTMLImageElement>('img');
    expect(image?.getAttribute('src')).toBe('joy-asset://library/images/Cover%20Art.png');

    await act(async () => {
      image?.dispatchEvent(new Event('error'));
    });

    expect(mediaButton?.getAttribute('data-source')).toBe('none');
    expect(mediaButton?.querySelector('img')).toBeNull();
    expect(mediaButton?.querySelector('.asset-card-placeholder')).not.toBeNull();
  });

  it('keeps the placeholder in a browser without the desktop bridge', async () => {
    setBridge(undefined);
    await mountAssetCardMedia();

    const mediaButton = container?.querySelector<HTMLButtonElement>('.asset-card-media');
    expect(mediaButton?.getAttribute('data-source')).toBe('none');
    expect(mediaButton?.querySelector('img')).toBeNull();
    expect(mediaButton?.querySelector('.asset-card-placeholder')).not.toBeNull();
  });
});
