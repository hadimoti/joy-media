import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import { MAX_COVER_DATA_URL_LENGTH } from './project-card.js';
import { PROJECT_CATALOG_KEY, updateCatalogProjectCard } from './project-catalog.js';

/** One read-back of the Monitor: RGBA pixels, as `renderer.readPixels` returns them. */
export interface CoverPixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** The longest side of a saved cover, in pixels. Small on purpose: the catalog is browser storage. */
export const COVER_MAX_SIDE = 192;

/** True when every pixel is the same colour: an empty frame makes a worse cover than the placeholder. */
export function isFlatFrame(pixels: CoverPixels): boolean {
  const { data } = pixels;
  if (data.length < 8) return true;
  for (let index = 4; index < data.length; index += 4) {
    if (
      data[index] !== data[0] ||
      data[index + 1] !== data[1] ||
      data[index + 2] !== data[2] ||
      data[index + 3] !== data[3]
    )
      return false;
  }
  return true;
}

/**
 * Encodes a frame as a small JPEG data URL. Returns undefined when the browser cannot
 * (no canvas, no 2d context, an encoder that answers PNG) or the result is too large.
 */
export function coverDataUrlFromPixels(pixels: CoverPixels): string | undefined {
  try {
    if (typeof document === 'undefined' || typeof ImageData === 'undefined') return undefined;
    if (pixels.width <= 0 || pixels.height <= 0) return undefined;
    if (pixels.data.length !== pixels.width * pixels.height * 4) return undefined;
    const source = document.createElement('canvas');
    source.width = pixels.width;
    source.height = pixels.height;
    const sourceContext = source.getContext('2d');
    if (sourceContext === null) return undefined;
    sourceContext.putImageData(
      new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height),
      0,
      0,
    );
    const scale = Math.min(1, COVER_MAX_SIDE / Math.max(pixels.width, pixels.height));
    const target = document.createElement('canvas');
    target.width = Math.max(1, Math.round(pixels.width * scale));
    target.height = Math.max(1, Math.round(pixels.height * scale));
    const targetContext = target.getContext('2d');
    if (targetContext === null) return undefined;
    // JPEG has no alpha: paint the frame over black, as the Monitor shows it.
    targetContext.fillStyle = '#000';
    targetContext.fillRect(0, 0, target.width, target.height);
    targetContext.drawImage(source, 0, 0, target.width, target.height);
    const url = target.toDataURL('image/jpeg', 0.7);
    if (!url.startsWith('data:image/jpeg;base64,')) return undefined;
    return url.length <= MAX_COVER_DATA_URL_LENGTH ? url : undefined;
  } catch {
    return undefined;
  }
}

export interface ProjectCardSnapshot {
  readonly projectId: string;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly durationUs: number;
  /** Reads the Monitor's current frame; may return undefined or throw. */
  readonly readFrame?: (() => CoverPixels | undefined) | undefined;
}

/**
 * Saves a project's card facts into the catalog. The cover is best effort: any failure to
 * read or encode the frame keeps the old cover, and any failure to write is swallowed, so a
 * save never breaks the editor. Returns true when the catalog was written.
 */
export function saveProjectCard(
  storage: BrowserKeyValueStore,
  snapshot: ProjectCardSnapshot,
): boolean {
  try {
    let coverDataUrl: string | undefined;
    try {
      const pixels = snapshot.readFrame?.();
      if (pixels !== undefined && !isFlatFrame(pixels)) {
        coverDataUrl = coverDataUrlFromPixels(pixels);
      }
    } catch {
      // Cover capture is optional; the card keeps its old cover or the placeholder.
    }
    const before = storage.getItem(PROJECT_CATALOG_KEY);
    updateCatalogProjectCard(storage, snapshot.projectId, {
      canvas: snapshot.canvas,
      durationUs: snapshot.durationUs,
      coverDataUrl,
    });
    return storage.getItem(PROJECT_CATALOG_KEY) !== before;
  } catch {
    return false;
  }
}
