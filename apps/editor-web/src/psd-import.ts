import type { JoyProjectV1, VisualObjectV1 } from '@joy-media/project-schema';
import type {
  BrowserAsset,
  BrowserAssetRegistration,
  BrowserControlPlaneClient,
} from './control-plane-client.js';
import type {
  OriginalAssetDescriptor,
  OpfsOriginalAssetCache,
} from './opfs-original-asset-cache.js';

export type PsdLayerType = 'raster' | 'text' | 'group' | 'adjustment' | 'smart-object' | 'unknown';

export interface PsdLayerDto {
  readonly id: string;
  readonly name: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly opacity: number;
  readonly visible: boolean;
  readonly type: PsdLayerType;
  readonly text?: string;
  readonly rasterBlob?: Blob;
}

export interface PsdWarning {
  readonly code: 'adjustment-unsupported' | 'smart-object-unsupported' | 'unknown-layer';
  readonly layerId: string;
  readonly message: string;
}

export interface PsdParseResult {
  readonly layers: readonly PsdLayerDto[];
  readonly warnings: readonly PsdWarning[];
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly parseTimeMs: number;
  readonly sourceName?: string;
  readonly sourceMimeType: string;
}

export type PsdImportErrorCode = 'invalid-psd' | 'too-large' | 'memory-budget' | 'unsupported';

export class PsdImportError extends Error {
  constructor(
    readonly code: PsdImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PsdImportError';
  }
}

interface AgPsdLayer {
  readonly top?: number;
  readonly left?: number;
  readonly bottom?: number;
  readonly right?: number;
  readonly opacity?: number;
  readonly hidden?: boolean;
  readonly name?: string;
  readonly id?: number;
  readonly canvas?: unknown;
  readonly imageData?: unknown;
  readonly children?: AgPsdLayer[];
  readonly text?: { readonly text?: string };
  readonly adjustment?: unknown;
  readonly placedLayer?: unknown;
}

interface AgPsdDocument {
  readonly width?: number;
  readonly height?: number;
  readonly children?: AgPsdLayer[];
}

const DEFAULT_MAX_PIXELS = 3840 * 2160;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const DEFAULT_MEMORY_BUDGET = 256 * 1024 * 1024;

export async function parsePsdFile(
  file: File | Blob,
  options: {
    readonly maxPixels?: number;
    readonly maxBytes?: number;
    readonly memoryBudgetBytes?: number;
  } = {},
): Promise<PsdParseResult> {
  const bytes = await file.arrayBuffer();
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (bytes.byteLength > maxBytes) {
    throw new PsdImportError(
      'too-large',
      `PSD file is ${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB; the limit is ${(
        maxBytes /
        (1024 * 1024)
      ).toFixed(0)} MB.`,
    );
  }
  const sha256 = await sha256Hex(bytes);
  const { readPsd } = await import('ag-psd');
  const started = performance.now();
  let structure: AgPsdDocument;
  try {
    structure = readPsd(bytes, {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
      logMissingFeatures: false,
    }) as unknown as AgPsdDocument;
  } catch (error) {
    throw new PsdImportError('invalid-psd', `Unable to read this PSD: ${message(error)}`);
  }
  const width = structure.width ?? 0;
  const height = structure.height ?? 0;
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  const memoryBudgetBytes = options.memoryBudgetBytes ?? DEFAULT_MEMORY_BUDGET;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new PsdImportError('invalid-psd', 'The PSD has invalid canvas dimensions.');
  }
  if (width * height > maxPixels) {
    throw new PsdImportError(
      'too-large',
      `PSD canvas ${width}×${height} exceeds the ${maxPixels.toLocaleString()} pixel limit.`,
    );
  }
  if (width * height * 4 > memoryBudgetBytes) {
    throw new PsdImportError(
      'memory-budget',
      `PSD raster memory exceeds the ${Math.round(memoryBudgetBytes / (1024 * 1024))} MB budget.`,
    );
  }

  let parsed: AgPsdDocument;
  try {
    parsed = readPsd(bytes, {
      skipCompositeImageData: true,
      skipThumbnail: true,
      useImageData: true,
      logMissingFeatures: false,
    }) as unknown as AgPsdDocument;
  } catch (error) {
    throw new PsdImportError('invalid-psd', `Unable to decode PSD layers: ${message(error)}`);
  }
  const layers: PsdLayerDto[] = [];
  const warnings: PsdWarning[] = [];
  const flatten = async (children: readonly AgPsdLayer[] | undefined): Promise<void> => {
    if (children === undefined) return;
    for (const layer of children) {
      const index = layers.length;
      const id = String(layer.id ?? `layer-${index + 1}`);
      const type = classifyLayer(layer);
      const left = layer.left ?? 0;
      const top = layer.top ?? 0;
      const right = layer.right ?? left;
      const bottom = layer.bottom ?? top;
      const dto: PsdLayerDto = {
        id,
        name: layer.name ?? `Layer ${index + 1}`,
        bounds: {
          x: clamp(left, 0, width),
          y: clamp(top, 0, height),
          width: clamp(right - left, 0, width),
          height: clamp(bottom - top, 0, height),
        },
        opacity: clamp((layer.opacity ?? 255) / 255, 0, 1),
        visible: layer.hidden !== true,
        type,
        ...(type === 'text' && layer.text?.text !== undefined ? { text: layer.text.text } : {}),
      };
      if (type === 'raster') {
        const rasterBlob = rasterBlobFromLayer(layer);
        if (rasterBlob !== undefined) {
          const blob = await rasterBlob;
          if (blob !== undefined) (dto as { rasterBlob?: Blob }).rasterBlob = blob;
        }
      }
      layers.push(dto);
      if (type === 'adjustment') {
        warnings.push({
          code: 'adjustment-unsupported',
          layerId: id,
          message: `Adjustment layer “${dto.name}” will not be edited; choose ignore or flatten group.`,
        });
      } else if (type === 'smart-object') {
        warnings.push({
          code: 'smart-object-unsupported',
          layerId: id,
          message: `Smart Object “${dto.name}” is opaque; source editing is not supported.`,
        });
      } else if (type === 'unknown') {
        warnings.push({
          code: 'unknown-layer',
          layerId: id,
          message: `Layer “${dto.name}” has no supported payload and will default to ignore.`,
        });
      }
      await flatten(layer.children);
    }
  };
  await flatten(parsed.children);
  const sourceName = typeof File !== 'undefined' && file instanceof File ? file.name : undefined;
  return {
    layers,
    warnings,
    width,
    height,
    bytes: bytes.byteLength,
    sha256,
    parseTimeMs: performance.now() - started,
    ...(sourceName !== undefined ? { sourceName } : {}),
    sourceMimeType: file.type || 'image/vnd.adobe.photoshop',
  };
}

export type PsdLayerMapping = 'image-object' | 'text-object' | 'flatten-group' | 'ignore';

export interface PsdAssetRefs {
  readonly sourceAssetId: string;
  readonly layerAssetIds: Readonly<Record<string, string>>;
}

export interface PsdAssetRegistrationOptions {
  readonly client: Pick<BrowserControlPlaneClient, 'registerAsset'>;
  readonly projectId: string;
  readonly cache: Pick<OpfsOriginalAssetCache, 'put'>;
  readonly file: File | Blob;
  readonly parsed: PsdParseResult;
  readonly selectedLayerIds: readonly string[];
}

export async function registerPsdAssets(
  options: PsdAssetRegistrationOptions,
): Promise<PsdAssetRefs> {
  const sourceAssetId = opaqueId(`psd-${options.parsed.sha256.slice(0, 24)}`);
  await registerBlob(
    options,
    sourceAssetId,
    options.file,
    options.parsed.sourceMimeType,
    'PSD source',
  );
  const layerAssetIds: Record<string, string> = {};
  const selected = new Set(options.selectedLayerIds);
  for (const layer of options.parsed.layers) {
    if (!selected.has(layer.id) || layer.rasterBlob === undefined) continue;
    const blob = layer.rasterBlob;
    const hash = await sha256Hex(await blob.arrayBuffer());
    const assetId = opaqueId(`psd-${options.parsed.sha256.slice(0, 12)}-${hash.slice(0, 12)}`);
    await registerBlob(options, assetId, blob, 'image/png', `PSD layer ${layer.name}`);
    layerAssetIds[layer.id] = assetId;
  }
  return { sourceAssetId, layerAssetIds };
}

export function buildPsdDocumentSnapshot(
  project: JoyProjectV1,
  parsed: PsdParseResult,
  mappings: Readonly<Record<string, PsdLayerMapping>>,
  assets: PsdAssetRefs,
  seed: string,
): JoyProjectV1 {
  let next = {
    ...project,
    assets: {
      ...project.assets,
      [assets.sourceAssetId]: {
        id: assets.sourceAssetId,
        kind: 'image' as const,
        displayName: parsed.sourceName ?? 'PSD source',
      },
    },
    visualObjects: { ...project.visualObjects },
  };
  const usedIds = new Set(Object.keys(next.visualObjects));
  for (const layer of parsed.layers) {
    const mapping = mappings[layer.id] ?? 'ignore';
    if (mapping === 'ignore' || !layer.visible) continue;
    const assetId =
      assets.layerAssetIds[layer.id] ??
      (mapping === 'flatten-group' ? assets.sourceAssetId : undefined);
    if (mapping === 'image-object' && assetId === undefined) continue;
    if (mapping === 'flatten-group' && assetId === undefined) continue;
    if (mapping === 'text-object' && (layer.text ?? '').length === 0) continue;
    const baseId = `psd-${seed}-${layer.id}`;
    let objectId = baseId;
    for (let suffix = 2; usedIds.has(objectId); suffix += 1) objectId = `${baseId}-${suffix}`;
    usedIds.add(objectId);
    const transform = {
      x: layer.bounds.x,
      y: layer.bounds.y,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: layer.opacity,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    const object: VisualObjectV1 =
      mapping === 'text-object'
        ? { id: objectId, kind: 'text', text: layer.text ?? layer.name, transform }
        : { id: objectId, kind: 'image', assetId: assetId!, transform };
    next = {
      ...next,
      visualObjects: { ...next.visualObjects, [objectId]: object },
      assets:
        assetId === undefined || next.assets[assetId] !== undefined
          ? next.assets
          : { ...next.assets, [assetId]: { id: assetId, kind: 'image', displayName: layer.name } },
    };
  }
  return next;
}

async function registerBlob(
  options: PsdAssetRegistrationOptions,
  assetId: string,
  blob: Blob,
  mimeType: string,
  displayName: string,
): Promise<BrowserAsset> {
  const bytes = await blob.arrayBuffer();
  const sha256 = await sha256Hex(bytes);
  const descriptor: OriginalAssetDescriptor = { assetId, sha256, bytes: blob.size, mimeType };
  await options.cache.put(descriptor, blob);
  const registration: BrowserAssetRegistration = {
    id: assetId,
    kind: 'image',
    displayName,
    sha256,
    bytes: blob.size,
    descriptor: { mimeType },
    locations: [{ kind: 'opfs-cache', ref: `opfs-${sha256.slice(0, 32)}` }],
  };
  return options.client.registerAsset(options.projectId, registration);
}

function classifyLayer(layer: AgPsdLayer): PsdLayerType {
  if (layer.children !== undefined) return 'group';
  if (layer.text !== undefined) return 'text';
  if (layer.adjustment !== undefined) return 'adjustment';
  if (layer.placedLayer !== undefined) return 'smart-object';
  if (layer.canvas !== undefined || layer.imageData !== undefined) return 'raster';
  return 'unknown';
}

async function rasterBlobFromLayer(layer: AgPsdLayer): Promise<Blob | undefined> {
  const candidate = layer.canvas as
    | {
        readonly toBlob?: (callback: (blob: Blob | null) => void, type?: string) => void;
        readonly convertToBlob?: (options?: { type?: string }) => Promise<Blob>;
      }
    | undefined;
  if (candidate?.convertToBlob !== undefined) return candidate.convertToBlob({ type: 'image/png' });
  if (candidate?.toBlob !== undefined) {
    return new Promise((resolve) =>
      candidate.toBlob?.((blob) => resolve(blob ?? undefined), 'image/png'),
    );
  }
  const imageData = layer.imageData as
    | { readonly width?: number; readonly height?: number; readonly data?: ArrayLike<number> }
    | undefined;
  if (
    imageData?.width === undefined ||
    imageData.height === undefined ||
    imageData.data === undefined
  )
    return undefined;
  const width = imageData.width;
  const height = imageData.height;
  const pixels = new Uint8ClampedArray(imageData.data);
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context !== null) {
      context.putImageData(new ImageData(pixels, width, height), 0, 0);
      return canvas.convertToBlob({ type: 'image/png' });
    }
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context !== null) {
      context.putImageData(new ImageData(pixels, width, height), 0, 0);
      return new Promise((resolve) =>
        canvas.toBlob((blob) => resolve(blob ?? undefined), 'image/png'),
      );
    }
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

function opaqueId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120);
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (globalThis.crypto?.subtle === undefined)
    throw new PsdImportError('unsupported', 'SHA-256 is unavailable in this browser.');
  return Array.from(
    new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buffer)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
