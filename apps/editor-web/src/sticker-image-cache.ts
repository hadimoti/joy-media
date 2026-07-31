/**
 * Loads sticker / image VisualObject pixels from OPFS originals (or File blobs)
 * into BrowserVideoFrameBitmap-compatible RGBA buffers for Monitor/export.
 */

export interface StickerBitmap {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface CropInsets {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

type CacheEntry = {
  readonly assetId: string;
  readonly matteAssetId?: string;
  readonly cropKey: string;
  readonly bitmap: StickerBitmap;
};

/** In-memory RGBA cache keyed by visual object id. */
export class StickerImageCache {
  private readonly byObjectId = new Map<string, CacheEntry>();
  private readonly assetBlobs = new Map<string, Blob>();

  rememberBlob(assetId: string, blob: Blob): void {
    this.assetBlobs.set(assetId, blob);
  }

  hasBlob(assetId: string): boolean {
    return this.assetBlobs.has(assetId);
  }

  get(objectId: string): StickerBitmap | undefined {
    return this.byObjectId.get(objectId)?.bitmap;
  }

  bitmaps(): ReadonlyMap<string, StickerBitmap> {
    const out = new Map<string, StickerBitmap>();
    for (const [id, entry] of this.byObjectId) out.set(id, entry.bitmap);
    return out;
  }

  clear(): void {
    this.byObjectId.clear();
    this.assetBlobs.clear();
  }

  async syncObject(options: {
    readonly objectId: string;
    readonly assetId: string;
    readonly matteAssetId?: string;
    readonly crop: CropInsets;
    readonly loadBlob: (assetId: string) => Promise<Blob | undefined>;
  }): Promise<StickerBitmap | undefined> {
    const cropKey = cropSignature(options.crop);
    const existing = this.byObjectId.get(options.objectId);
    if (
      existing !== undefined &&
      existing.assetId === options.assetId &&
      existing.matteAssetId === options.matteAssetId &&
      existing.cropKey === cropKey
    ) {
      return existing.bitmap;
    }

    let blob = this.assetBlobs.get(options.assetId);
    if (blob === undefined) {
      blob = await options.loadBlob(options.assetId);
      if (blob === undefined) return undefined;
      this.assetBlobs.set(options.assetId, blob);
    }

    let rgba = await decodeBlobToRgba(blob);
    if (options.matteAssetId !== undefined) {
      let matteBlob = this.assetBlobs.get(options.matteAssetId);
      if (matteBlob === undefined) {
        matteBlob = await options.loadBlob(options.matteAssetId);
        if (matteBlob !== undefined) this.assetBlobs.set(options.matteAssetId, matteBlob);
      }
      if (matteBlob !== undefined) {
        const matte = await decodeBlobToRgba(matteBlob);
        rgba = applyMatteAlpha(rgba, matte);
      }
    }
    rgba = applyCrop(rgba, options.crop);
    this.byObjectId.set(options.objectId, {
      assetId: options.assetId,
      ...(options.matteAssetId !== undefined ? { matteAssetId: options.matteAssetId } : {}),
      cropKey,
      bitmap: rgba,
    });
    this.pruneUnusedAssetBlobs();
    return rgba;
  }

  clearObject(objectId: string): void {
    this.byObjectId.delete(objectId);
    this.pruneUnusedAssetBlobs();
  }

  clearMissing(objectIds: ReadonlySet<string>): void {
    for (const objectId of [...this.byObjectId.keys()]) {
      if (!objectIds.has(objectId)) {
        this.byObjectId.delete(objectId);
      }
    }
    this.pruneUnusedAssetBlobs();
  }

  private pruneUnusedAssetBlobs(): void {
    const usedAssetIds = new Set<string>();
    for (const entry of this.byObjectId.values()) {
      usedAssetIds.add(entry.assetId);
      if (entry.matteAssetId !== undefined) usedAssetIds.add(entry.matteAssetId);
    }
    for (const assetId of [...this.assetBlobs.keys()]) {
      if (!usedAssetIds.has(assetId)) this.assetBlobs.delete(assetId);
    }
  }
}

function cropSignature(crop: CropInsets): string {
  return `${crop.left},${crop.top},${crop.right},${crop.bottom}`;
}

async function decodeBlobToRgba(blob: Blob): Promise<StickerBitmap> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) throw new Error('2d canvas unavailable for sticker decode');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return {
      width: image.width,
      height: image.height,
      data: image.data,
    };
  } finally {
    bitmap.close();
  }
}

/** Crop insets are fractions of source size in 0..0.49 (CapCut-like). */
function applyCrop(source: StickerBitmap, crop: CropInsets): StickerBitmap {
  const left = clampFraction(crop.left);
  const top = clampFraction(crop.top);
  const right = clampFraction(crop.right);
  const bottom = clampFraction(crop.bottom);
  if (left === 0 && top === 0 && right === 0 && bottom === 0) return source;
  const x0 = Math.floor(source.width * left);
  const y0 = Math.floor(source.height * top);
  const x1 = Math.max(x0 + 1, Math.ceil(source.width * (1 - right)));
  const y1 = Math.max(y0 + 1, Math.ceil(source.height * (1 - bottom)));
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const srcRow = ((y0 + y) * source.width + x0) * 4;
    const dstRow = y * width * 4;
    data.set(source.data.subarray(srcRow, srcRow + width * 4), dstRow);
  }
  return { width, height, data };
}

function applyMatteAlpha(source: StickerBitmap, matte: StickerBitmap): StickerBitmap {
  const width = Math.min(source.width, matte.width);
  const height = Math.min(source.height, matte.height);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const si = (y * source.width + x) * 4;
      const mi = (y * matte.width + x) * 4;
      const di = (y * width + x) * 4;
      data[di] = source.data[si]!;
      data[di + 1] = source.data[si + 1]!;
      data[di + 2] = source.data[si + 2]!;
      // Use matte luminance as alpha (RemBG mask is typically white=keep).
      const m = matte.data[mi]!;
      data[di + 3] = Math.round((m / 255) * source.data[si + 3]!);
    }
  }
  return { width, height, data };
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.49, Math.max(0, value));
}
