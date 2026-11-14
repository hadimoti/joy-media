// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import { coverDataUrlFromPixels, isFlatFrame, saveProjectCard } from './project-card-save.js';
import { getCatalogProject, PROJECT_CATALOG_KEY } from './project-catalog.js';

const NOW = '2026-11-01T10:00:00.000Z';

function storeWithProject(): BrowserKeyValueStore {
  const values = new Map<string, string>();
  values.set(
    PROJECT_CATALOG_KEY,
    JSON.stringify({
      version: 4,
      projects: {
        alpha: {
          id: 'alpha',
          title: 'Alpha',
          createdAt: NOW,
          updatedAt: NOW,
          timelineProjectId: 'alpha',
          visualProjectId: 'alpha',
        },
      },
    }),
  );
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function pixels(width: number, height: number, fill: (index: number) => number[]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) data.set(fill(index), index * 4);
  return { width, height, data };
}

const FLAT = pixels(4, 2, () => [10, 20, 30, 255]);
const PICTURE = pixels(4, 2, (index) => [index * 30, 0, 0, 255]);
const COVER = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('isFlatFrame', () => {
  it('is true for one colour and false once a pixel differs', () => {
    expect(isFlatFrame(FLAT)).toBe(true);
    expect(isFlatFrame(PICTURE)).toBe(false);
  });
});

describe('coverDataUrlFromPixels', () => {
  it('skips silently when the browser cannot draw (no 2d context)', () => {
    vi.stubGlobal(
      'ImageData',
      class {
        constructor(
          readonly data: Uint8ClampedArray,
          readonly width: number,
          readonly height: number,
        ) {}
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(coverDataUrlFromPixels(PICTURE)).toBeUndefined();
  });

  it('skips when the pixel buffer does not match its size', () => {
    expect(
      coverDataUrlFromPixels({ width: 4, height: 2, data: new Uint8ClampedArray(3) }),
    ).toBeUndefined();
  });

  it('returns the JPEG the canvas encodes, and refuses a PNG answer', () => {
    vi.stubGlobal(
      'ImageData',
      class {
        constructor(
          readonly data: Uint8ClampedArray,
          readonly width: number,
          readonly height: number,
        ) {}
      },
    );
    const context = {
      putImageData: vi.fn(),
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      fillStyle: '',
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    const toDataURL = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValueOnce(COVER)
      .mockReturnValueOnce('data:image/png;base64,iVBORw0KGgo=');
    expect(coverDataUrlFromPixels(PICTURE)).toBe(COVER);
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', expect.any(Number));
    expect(coverDataUrlFromPixels(PICTURE)).toBeUndefined();
  });

  it('swallows an encoder that throws', () => {
    vi.stubGlobal(
      'ImageData',
      class {
        constructor(
          readonly data: Uint8ClampedArray,
          readonly width: number,
          readonly height: number,
        ) {}
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      throw new Error('GPU lost');
    });
    expect(coverDataUrlFromPixels(PICTURE)).toBeUndefined();
  });
});

describe('saveProjectCard', () => {
  const base = { projectId: 'alpha', canvas: { width: 1080, height: 1920 }, durationUs: 24_000_000 };

  it('saves format and length even when no frame can be read', () => {
    const storage = storeWithProject();
    expect(saveProjectCard(storage, base)).toBe(true);
    const saved = getCatalogProject(storage, 'alpha');
    expect(saved?.canvas).toEqual({ width: 1080, height: 1920 });
    expect(saved?.durationUs).toBe(24_000_000);
    expect(saved?.coverDataUrl).toBeUndefined();
    // The edit time is not touched by a card save.
    expect(saved?.updatedAt).toBe(NOW);
  });

  it('writes nothing when nothing changed', () => {
    const storage = storeWithProject();
    saveProjectCard(storage, base);
    const setItem = vi.spyOn(storage, 'setItem');
    expect(saveProjectCard(storage, base)).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('keeps the old cover when the frame read throws or is flat', () => {
    const storage = storeWithProject();
    saveProjectCard(storage, base);
    const catalog = JSON.parse(storage.getItem(PROJECT_CATALOG_KEY) ?? '{}') as {
      projects: Record<string, Record<string, unknown>>;
    };
    const alpha = catalog.projects.alpha;
    if (alpha === undefined) throw new Error('missing alpha');
    alpha.coverDataUrl = COVER;
    storage.setItem(PROJECT_CATALOG_KEY, JSON.stringify(catalog));
    expect(
      saveProjectCard(storage, {
        ...base,
        durationUs: 30_000_000,
        readFrame: () => {
          throw new Error('renderer disposed');
        },
      }),
    ).toBe(true);
    expect(getCatalogProject(storage, 'alpha')?.coverDataUrl).toBe(COVER);
    saveProjectCard(storage, { ...base, durationUs: 31_000_000, readFrame: () => FLAT });
    expect(getCatalogProject(storage, 'alpha')?.coverDataUrl).toBe(COVER);
    expect(getCatalogProject(storage, 'alpha')?.durationUs).toBe(31_000_000);
  });

  it('does nothing for a project that is not in the catalog', () => {
    const storage = storeWithProject();
    expect(saveProjectCard(storage, { ...base, projectId: 'missing' })).toBe(false);
  });

  it('never throws when the store refuses the write', () => {
    const storage = storeWithProject();
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('storage is read-only after the lock was released');
    });
    expect(saveProjectCard(storage, base)).toBe(false);
  });
});
