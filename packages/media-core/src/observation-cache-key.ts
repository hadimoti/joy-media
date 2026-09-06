export interface ObservationCacheCrop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ObservationCacheKeyInput {
  readonly assetDigest: string;
  readonly streamId: string;
  readonly crop: ObservationCacheCrop;
  readonly rotationDeg: 0 | 90 | 180 | 270;
  readonly representation: 'original' | 'proxy';
  readonly modelId: string;
  readonly analysisVersion: string;
}

const DIGEST = /^[a-f0-9]{64}$/i;
const STREAM = /^[A-Za-z0-9._-]{1,128}$/;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$/;
const CACHE_KEY_INPUT_KEYS = [
  'assetDigest',
  'streamId',
  'crop',
  'rotationDeg',
  'representation',
  'modelId',
  'analysisVersion',
] as const;
const CROP_KEYS = ['x', 'y', 'width', 'height'] as const;

/**
 * An opaque deterministic cache key. Its fixed component order prevents a
 * proxy, crop, rotation, model, or analysis revision from borrowing evidence
 * produced for another representation. URLs and filesystem paths are rejected.
 */
export function createObservationCacheKey(input: ObservationCacheKeyInput): string {
  if (!isPlainRecord(input) || !hasExactKeys(input, CACHE_KEY_INPUT_KEYS))
    throw new RangeError('cache input must contain only bounded identity fields');
  if (typeof input.assetDigest !== 'string' || !DIGEST.test(input.assetDigest))
    throw new RangeError('assetDigest must be a SHA-256 hex digest');
  if (typeof input.streamId !== 'string' || !STREAM.test(input.streamId))
    throw new RangeError('streamId must be an opaque token');
  if (typeof input.modelId !== 'string' || !isOpaqueIdentifier(input.modelId))
    throw new RangeError('modelId must be an opaque identifier');
  if (typeof input.analysisVersion !== 'string' || !isOpaqueIdentifier(input.analysisVersion))
    throw new RangeError('analysisVersion must be an opaque identifier');
  if (
    input.rotationDeg !== 0 &&
    input.rotationDeg !== 90 &&
    input.rotationDeg !== 180 &&
    input.rotationDeg !== 270
  )
    throw new RangeError('rotationDeg must be 0, 90, 180, or 270');
  if (input.representation !== 'original' && input.representation !== 'proxy')
    throw new RangeError('representation must be original or proxy');
  assertCrop(input.crop);
  return [
    'joy-observation:v1',
    input.assetDigest.toLowerCase(),
    input.streamId,
    `${input.crop.x},${input.crop.y},${input.crop.width},${input.crop.height}`,
    input.rotationDeg,
    input.representation,
    input.modelId,
    input.analysisVersion,
  ]
    .map((part) => encodeURIComponent(String(part)))
    .join(':');
}

function assertCrop(crop: unknown): asserts crop is ObservationCacheCrop {
  if (!isPlainRecord(crop) || !hasExactKeys(crop, CROP_KEYS))
    throw new RangeError('crop must contain only x, y, width, and height');
  const x = crop.x;
  const y = crop.y;
  const width = crop.width;
  const height = crop.height;
  assertNonNegativeSafeInteger(x, 'crop.x');
  assertNonNegativeSafeInteger(y, 'crop.y');
  assertNonNegativeSafeInteger(width, 'crop.width');
  assertNonNegativeSafeInteger(height, 'crop.height');
  if (width === 0 || height === 0) throw new RangeError('crop width and height must be positive');
  if (x + width > Number.MAX_SAFE_INTEGER)
    throw new RangeError('crop.x + crop.width must remain in the safe integer range');
  if (y + height > Number.MAX_SAFE_INTEGER)
    throw new RangeError('crop.y + crop.height must remain in the safe integer range');
}

function isOpaqueIdentifier(value: string): boolean {
  return value.length <= 128 && OPAQUE_IDENTIFIER.test(value);
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be a non-negative safe integer`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value)];
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
