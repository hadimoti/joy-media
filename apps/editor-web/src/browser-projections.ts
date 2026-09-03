import type {
  BrowserAnimationDescriptor,
  BrowserAsset,
  BrowserJob,
  BrowserMediaDescriptor,
  BrowserStockVideo,
  BrowserStockVideoCategory,
  BrowserStockVideoImport,
  BrowserStockVideoPage,
} from './control-plane-client.js';

const STOCK_VIDEO_CATEGORY_IDS = [
  'business-work',
  'technology',
  'people-lifestyle',
  'nature',
  'travel-places',
  'city-transport',
  'food-drink',
  'abstract-backgrounds',
] as const;

export function browserJobList(value: unknown): readonly BrowserJob[] {
  if (!Array.isArray(value)) throw invalidJobResponse();
  return value.map(browserJob);
}

export function browserJob(value: unknown): BrowserJob {
  if (!isRecord(value)) throw invalidJobResponse();
  const state = value.state;
  if (!['queued', 'leased', 'completed', 'canceled', 'failed'].includes(String(state)))
    throw invalidJobResponse();
  if (typeof value.cancelRequested !== 'boolean') throw invalidJobResponse();
  const derivative = value.derivative === undefined ? undefined : jobDerivative(value.derivative);
  return {
    id: opaque(value.id),
    projectId: opaque(value.projectId),
    type: opaque(value.type),
    ...(value.assetId === undefined ? {} : { assetId: opaque(value.assetId) }),
    state: state as BrowserJob['state'],
    progress: boundedInteger(value.progress, 0, 100),
    cancelRequested: value.cancelRequested,
    ...(value.error === undefined ? {} : { error: safeString(value.error) }),
    ...(derivative === undefined ? {} : { derivative }),
  };
}

function jobDerivative(value: unknown): NonNullable<BrowserJob['derivative']> {
  if (!isRecord(value)) throw invalidJobResponse();
  return {
    id: opaque(value.id),
    jobId: opaque(value.jobId),
    kind: opaque(value.kind),
    sha256: hash(value.sha256),
    bytes: positive(value.bytes),
    workerRef: opaque(value.workerRef),
    resultRef: resultRef(value.resultRef),
    verifiedAt: nonNegative(value.verifiedAt),
  };
}

export function browserAssetList(value: unknown): readonly BrowserAsset[] {
  if (!Array.isArray(value)) throw invalidAssetResponse();
  return value.map(browserAsset);
}

export function browserAsset(value: unknown): BrowserAsset {
  if (!isRecord(value)) throw invalidAssetResponse();
  if (!['video', 'audio', 'image'].includes(String(value.kind))) throw invalidAssetResponse();
  if (typeof value.cloudBacked !== 'boolean') throw invalidAssetResponse();
  return {
    id: string(value.id),
    projectId: string(value.projectId),
    kind: value.kind as BrowserAsset['kind'],
    displayName: string(value.displayName),
    sha256: hash(value.sha256),
    bytes: positive(value.bytes),
    descriptor: descriptor(value.descriptor),
    ...(value.tags === undefined ? {} : { tags: strings(value.tags) }),
    ...(value.sortName === undefined ? {} : { sortName: string(value.sortName) }),
    createdAt: nonNegative(value.createdAt),
    cloudBacked: value.cloudBacked,
  };
}

export function browserStockVideoPage(
  value: unknown,
  requestedCategory?: BrowserStockVideoCategory,
): BrowserStockVideoPage {
  if (!isRecord(value) || !Array.isArray(value.items)) throw invalidStockVideoResponse();
  const counts = {} as Record<BrowserStockVideoCategory, number>;
  if (isRecord(value.counts)) {
    for (const category of STOCK_VIDEO_CATEGORY_IDS) {
      const count = value.counts[category];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 6)
        throw invalidStockVideoResponse();
      counts[category] = count;
    }
  } else if (
    requestedCategory !== undefined &&
    typeof value.count === 'number' &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0 &&
    value.count <= 6
  ) {
    for (const category of STOCK_VIDEO_CATEGORY_IDS) counts[category] = 0;
    counts[requestedCategory] = value.count;
  } else {
    throw invalidStockVideoResponse();
  }
  const nextCursor = value.nextCursor;
  if (nextCursor !== undefined && (typeof nextCursor !== 'string' || nextCursor.length > 512))
    throw invalidStockVideoResponse();
  if (value.items.length > 6) throw invalidStockVideoResponse();
  return {
    items: value.items.map((item) => browserStockVideo(item, requestedCategory)),
    counts,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export function browserStockVideo(
  value: unknown,
  fallbackCategory?: BrowserStockVideoCategory,
): BrowserStockVideo {
  if (!isRecord(value)) throw invalidStockVideoResponse();
  const category = value.category ?? fallbackCategory;
  const provider = value.provider;
  const orientation = value.orientation;
  if (
    !STOCK_VIDEO_CATEGORY_IDS.includes(category as BrowserStockVideoCategory) ||
    (provider !== 'pexels' && provider !== 'pixabay') ||
    (orientation !== 'portrait' && orientation !== 'landscape')
  )
    throw invalidStockVideoResponse();
  const sourcePageUrl = string(value.sourcePageUrl);
  try {
    const url = new URL(sourcePageUrl);
    if (url.protocol !== 'https:') throw new Error('source page must be HTTPS');
  } catch {
    throw invalidStockVideoResponse();
  }
  const title = string(value.title);
  const creator = string(value.creator);
  const id = string(value.id);
  const durationUs = durationInMicroseconds(value.durationUs ?? value.durationSeconds);
  const width = positive(value.width);
  const height = positive(value.height);
  if (orientation === 'portrait' && width >= height) throw invalidStockVideoResponse();
  if (orientation === 'landscape' && height >= width) throw invalidStockVideoResponse();
  return {
    id,
    category: category as BrowserStockVideoCategory,
    title,
    provider,
    creator,
    sourcePageUrl,
    durationUs,
    width,
    height,
    orientation,
  };
}

function durationInMicroseconds(value: unknown): number {
  if (Number.isSafeInteger(value) && (value as number) > 0) return value as number;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw invalidStockVideoResponse();
  const durationUs = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(durationUs) || durationUs < 1) throw invalidStockVideoResponse();
  return durationUs;
}

export function browserStockVideoImport(value: unknown): BrowserStockVideoImport {
  if (!isRecord(value)) throw invalidStockVideoResponse();
  const state = value.state;
  if (
    !['claimed', 'downloading', 'object-stored', 'registered', 'completed', 'failed'].includes(
      String(state),
    )
  )
    throw invalidStockVideoResponse();
  if (value.errorCode !== undefined && typeof value.errorCode !== 'string')
    throw invalidStockVideoResponse();
  if (value.assetId !== undefined && typeof value.assetId !== 'string')
    throw invalidStockVideoResponse();
  const asset = value.asset === undefined ? undefined : browserAsset(value.asset);
  if (state === 'completed' && asset === undefined && value.assetId === undefined)
    throw invalidStockVideoResponse();
  return {
    importId: string(value.importId),
    state: state as BrowserStockVideoImport['state'],
    ...(value.assetId === undefined ? {} : { assetId: string(value.assetId) }),
    ...(value.errorCode === undefined ? {} : { errorCode: string(value.errorCode) }),
    ...(asset === undefined ? {} : { asset }),
  };
}

function descriptor(value: unknown): BrowserMediaDescriptor {
  if (!isRecord(value)) throw invalidAssetResponse();
  const animation = value.animation === undefined ? undefined : animated(value.animation);
  return {
    mimeType: string(value.mimeType),
    ...(value.durationUs === undefined ? {} : { durationUs: positive(value.durationUs) }),
    ...(value.width === undefined ? {} : { width: positive(value.width) }),
    ...(value.height === undefined ? {} : { height: positive(value.height) }),
    ...(animation === undefined ? {} : { animation }),
  };
}

function animated(value: unknown): BrowserAnimationDescriptor {
  if (!isRecord(value) || typeof value.hasAlpha !== 'boolean') throw invalidAssetResponse();
  return {
    frameCount: positive(value.frameCount),
    cycleDurationUs: positive(value.cycleDurationUs),
    loopCount: nonNegative(value.loopCount),
    hasAlpha: value.hasAlpha,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function string(value: unknown, error = invalidAssetResponse): string {
  if (typeof value !== 'string' || value.length === 0) throw error();
  return value;
}
function hash(value: unknown): string {
  const result = string(value);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw invalidAssetResponse();
  return result;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalidAssetResponse();
  return value as number;
}
function nonNegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidAssetResponse();
  return value as number;
}
function boundedInteger(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw invalidJobResponse();
  return value as number;
}
function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw invalidAssetResponse();
  return value as readonly string[];
}
function opaque(value: unknown): string {
  const result = string(value, invalidJobResponse);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(result)) throw invalidJobResponse();
  return result;
}
function resultRef(value: unknown): string {
  const result = string(value, invalidJobResponse);
  if (result.startsWith('derivative:')) {
    opaque(result.slice('derivative:'.length));
    return result;
  }
  return opaque(result);
}
function safeString(value: unknown): string {
  const result = string(value, invalidJobResponse);
  if (
    /^(?:file:|https?:\/\/)/iu.test(result) ||
    result.startsWith('/') ||
    /^[A-Za-z]:[\\/]/u.test(result) ||
    result.startsWith('\\\\')
  )
    throw invalidJobResponse();
  return result;
}
function invalidAssetResponse(): Error {
  return new Error('JOY Media API returned an invalid asset response');
}
function invalidStockVideoResponse(): Error {
  return new Error('JOY Media API returned an invalid stock video response');
}
function invalidJobResponse(): Error {
  return new Error('JOY Media API returned an invalid job response');
}
