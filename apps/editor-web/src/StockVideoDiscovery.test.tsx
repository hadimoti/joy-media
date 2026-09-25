// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STOCK_VIDEO_CATEGORIES,
  type BrowserControlPlaneClient,
  type BrowserStockVideoCategory,
  type BrowserStockVideo,
} from './control-plane-client.js';
import { StockVideoDiscovery } from './StockVideoDiscovery.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, {
      createObjectURL: vi.fn(() => 'blob:test'),
      revokeObjectURL: vi.fn(),
    }),
  );
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const videos: readonly BrowserStockVideo[] = [
  {
    id: 'one',
    category: 'technology',
    title: 'First video',
    provider: 'pexels',
    creator: 'Creator One',
    sourcePageUrl: 'https://example.test/one',
    durationUs: 1_000_000,
    width: 1280,
    height: 720,
    orientation: 'landscape',
  },
  {
    id: 'two',
    category: 'technology',
    title: 'Second video',
    provider: 'pixabay',
    creator: 'Creator Two',
    sourcePageUrl: 'https://example.test/two',
    durationUs: 2_000_000,
    width: 720,
    height: 1280,
    orientation: 'portrait',
  },
];

function clientStub(): BrowserControlPlaneClient {
  const counts = Object.fromEntries(STOCK_VIDEO_CATEGORIES.map(({ id }) => [id, 2])) as Record<
    BrowserStockVideoCategory,
    number
  >;
  return {
    stockVideos: vi.fn(async () => ({ items: videos, counts })),
    stockVideoPoster: vi.fn(
      async (id: string) => new Blob([`poster-${id}`], { type: 'image/png' }),
    ),
    stockVideoPreview: vi.fn(
      async (id: string) => new Blob([`preview-${id}`], { type: 'video/mp4' }),
    ),
  } as unknown as BrowserControlPlaneClient;
}

describe('StockVideoDiscovery object URL lifecycle', () => {
  it('detaches preview src and poster before revoke on close, replace, and unmount', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const rendered = container;
    const owners = new Map<string, HTMLElement[]>();
    const revoked: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      const contentType = blob instanceof Blob && blob.type === 'video/mp4' ? 'preview' : 'poster';
      return `blob:${contentType}:${Math.random().toString(36).slice(2)}`;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      revoked.push(url);
      for (const owner of owners.get(url) ?? []) {
        expect(owner.hasAttribute('src')).toBe(false);
        expect(owner.hasAttribute('poster')).toBe(false);
      }
    });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    const client = clientStub();
    const props = {
      client,
      projectId: 'project-test',
      query: '',
      category: 'technology' as const,
      categoryCounts: Object.fromEntries(STOCK_VIDEO_CATEGORIES.map(({ id }) => [id, 2])) as Record<
        BrowserStockVideoCategory,
        number
      >,
      onCategoryCountsChange: () => undefined,
      viewMode: 'large' as const,
      onImport: async () => undefined,
      onStatus: () => undefined,
    };
    await act(async () => root?.render(<StockVideoDiscovery {...props} />));

    const capturePreviewOwners = (): { readonly src: string; readonly poster: string } => {
      const video = rendered.querySelector('video')!;
      const src = video.getAttribute('src')!;
      const poster = video.getAttribute('poster')!;
      owners.set(src, [video]);
      owners.set(poster, [video]);
      for (const image of rendered.querySelectorAll('img')) {
        const imageUrl = image.getAttribute('src');
        if (imageUrl !== null) owners.set(imageUrl, [image]);
      }
      return { src, poster };
    };
    const open = async (
      title: string,
    ): Promise<{ readonly src: string; readonly poster: string }> => {
      await act(async () => {
        rendered.querySelector<HTMLButtonElement>(`button[aria-label="Preview ${title}"]`)?.click();
      });
      return capturePreviewOwners();
    };

    const first = await open('First video');
    await act(async () => {
      rendered
        .querySelector<HTMLButtonElement>('[aria-label="Close stock video preview"]')
        ?.click();
    });
    expect(revoked).toEqual(expect.arrayContaining([first.src, first.poster]));

    const secondFirst = await open('First video');
    const replacement = await open('Second video');
    expect(revoked).toEqual(expect.arrayContaining([secondFirst.src, secondFirst.poster]));

    await act(async () => root?.unmount());
    root = undefined;
    expect(revoked).toEqual(expect.arrayContaining([replacement.src, replacement.poster]));
  });

  it('revokes pending poster URL if component unmounts before state update commits', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const revoked: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:pending-poster');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      revoked.push(url);
    });

    let resolvePoster!: (blob: Blob) => void;
    const client = {
      stockVideos: vi.fn(async () => ({ items: [videos[0]!], counts: { technology: 1 } })),
      stockVideoPoster: vi.fn(
        () =>
          new Promise<Blob>((resolve) => {
            resolvePoster = resolve;
          }),
      ),
      stockVideoPreview: vi.fn(async () => new Blob(['preview'])),
    } as unknown as BrowserControlPlaneClient;

    const props = {
      client,
      projectId: 'project-test',
      query: '',
      category: 'technology' as const,
      categoryCounts: { technology: 1 } as Record<BrowserStockVideoCategory, number>,
      onCategoryCountsChange: () => undefined,
      viewMode: 'large' as const,
      onImport: async () => undefined,
      onStatus: () => undefined,
    };

    await act(async () => {
      root?.render(<StockVideoDiscovery {...props} />);
    });
    expect(revoked).toEqual([]);

    await act(async () => {
      resolvePoster(new Blob(['poster']));
      await Promise.resolve();
      root?.unmount();
      root = undefined;
    });

    expect(revoked).toEqual(['blob:pending-poster']);
  });

  it('revokes pending modal preview URLs if component unmounts before preview state commits', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const rendered = container;
    const revoked: string[] = [];
    let count = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      count += 1;
      return `blob:preview-modal-${count}`;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      revoked.push(url);
    });

    let resolvePreview!: (blob: Blob) => void;
    let resolvePoster!: (blob: Blob) => void;
    const client = {
      stockVideos: vi.fn(async () => ({ items: [videos[0]!], counts: { technology: 1 } })),
      stockVideoPoster: vi.fn(
        () =>
          new Promise<Blob>((resolve) => {
            resolvePoster = resolve;
          }),
      ),
      stockVideoPreview: vi.fn(
        () =>
          new Promise<Blob>((resolve) => {
            resolvePreview = resolve;
          }),
      ),
    } as unknown as BrowserControlPlaneClient;

    const props = {
      client,
      projectId: 'project-test',
      query: '',
      category: 'technology' as const,
      categoryCounts: { technology: 1 } as Record<BrowserStockVideoCategory, number>,
      onCategoryCountsChange: () => undefined,
      viewMode: 'large' as const,
      onImport: async () => undefined,
      onStatus: () => undefined,
    };

    await act(async () => {
      root?.render(<StockVideoDiscovery {...props} />);
    });

    // Click preview button
    await act(async () => {
      rendered
        .querySelector<HTMLButtonElement>('button[aria-label="Preview First video"]')
        ?.click();
    });

    // Resolve both preview and poster blobs
    await act(async () => {
      resolvePreview(new Blob(['preview'], { type: 'video/mp4' }));
      resolvePoster(new Blob(['poster'], { type: 'image/png' }));
      // Promise.all takes multiple microtasks to settle
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      root?.unmount();
      root = undefined;
    });

    expect(revoked).toEqual(
      expect.arrayContaining(['blob:preview-modal-1', 'blob:preview-modal-2']),
    );
  });
});
