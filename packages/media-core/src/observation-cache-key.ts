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
const VERSION = /^[A-Za-z0-9._/-]{1,128}$/;

/**
 * An opaque deterministic cache key. Its fixed component order prevents a
 * proxy, crop, rotation, model, or analysis revision from borrowing evidence
 * produced for another representation. URLs and filesystem paths are rejected.
 */
export function createObservationCacheKey(input: ObservationCacheKeyInput): string {
  if (!DIGEST.test(input.assetDigest))
    throw new RangeError('assetDigest must be a SHA-256 hex digest');
  if (!STREAM.test(input.streamId)) throw new RangeError('streamId must be an opaque token');
  if (!VERSION.test(input.modelId)) throw new RangeError('modelId must be an opaque identifier');
  if (!VERSION.test(input.analysisVersion))
    throw new RangeError('analysisVersion must be an opaque identifier');
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

function assertCrop(crop: ObservationCacheCrop): void {
  for (const [name, value] of Object.entries(crop))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError(`crop.${name} must be a non-negative safe integer`);
  if (crop.width === 0 || crop.height === 0)
    throw new RangeError('crop width and height must be positive');
}
