import {
  assertFrameIdentity,
  frameIdentityKey,
  type FrameIdentity,
} from '@joy-media/media-core/observation';
import type {
  SourceObservationDecodeFailureCode,
  SourceObservationRange,
} from './source-decoder.js';

export const DEFAULT_OBSERVATION_THUMBNAIL_BOUNDS = {
  maxWidth: 512,
  maxHeight: 512,
  maxBytes: 1_500_000,
  mimeType: 'image/jpeg',
  quality: 0.82,
} as const;

export interface ObservationThumbnailBounds {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxBytes: number;
  readonly mimeType: 'image/jpeg' | 'image/png';
  readonly quality: number;
}

/** A host-authored source request; it contains a Blob, never a path or URL. */
export interface ObservationWorkerDecodeRequest {
  readonly type: 'decode-range';
  readonly jobId: string;
  readonly assetDigest: string;
  readonly streamId: string;
  readonly source: Blob;
  readonly epoch: number;
  readonly range: SourceObservationRange;
  readonly thumbnail: ObservationThumbnailBounds;
}

export interface ObservationWorkerAckRequest {
  readonly type: 'ack-frame';
  readonly jobId: string;
  readonly sequence: number;
}

export interface ObservationWorkerCancelRequest {
  readonly type: 'cancel';
  readonly jobId: string;
}

export interface ObservationWorkerPlaybackRequest {
  readonly type: 'set-playback-priority';
  readonly active: boolean;
}

export type ObservationWorkerRequest =
  | ObservationWorkerDecodeRequest
  | ObservationWorkerAckRequest
  | ObservationWorkerCancelRequest
  | ObservationWorkerPlaybackRequest;

export interface ObservationWorkerThumbnail {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly mimeType: 'image/jpeg' | 'image/png';
}

export interface ObservationWorkerDecodedFrame {
  readonly id: string;
  readonly identity: FrameIdentity;
  readonly actualTimeUs: number;
  readonly durationUs: number;
  readonly presentationIndex: number;
  readonly width: number;
  readonly height: number;
  readonly thumbnail: ObservationWorkerThumbnail;
}

export interface ObservationWorkerFrameResponse {
  readonly type: 'frame';
  readonly jobId: string;
  readonly sequence: number;
  readonly frame: ObservationWorkerDecodedFrame;
}

export interface ObservationWorkerCompleteResponse {
  readonly type: 'complete';
  readonly jobId: string;
  readonly decodedFrameCount: number;
}

export interface ObservationWorkerCancelledResponse {
  readonly type: 'cancelled';
  readonly jobId: string;
}

export type ObservationWorkerFailureCode =
  | SourceObservationDecodeFailureCode
  | 'thumbnail-unsupported'
  | 'thumbnail-too-large'
  | 'thumbnail-failed'
  | 'consumer-timeout'
  | 'invalid-request'
  | 'worker-failed';

export interface ObservationWorkerFailedResponse {
  readonly type: 'failed';
  readonly jobId: string;
  /** A finite safe code only; raw decoder/media errors never cross this boundary. */
  readonly code: ObservationWorkerFailureCode;
}

export type ObservationWorkerResponse =
  | ObservationWorkerFrameResponse
  | ObservationWorkerCompleteResponse
  | ObservationWorkerCancelledResponse
  | ObservationWorkerFailedResponse;

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STREAM_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SHA_256 = /^[a-f0-9]{64}$/i;
const FAILURE_CODES: readonly ObservationWorkerFailureCode[] = [
  'cancelled',
  'closed',
  'invalid-range',
  'missing-video-track',
  'unsupported-codec',
  'backpressure',
  'decode-failed',
  'thumbnail-unsupported',
  'thumbnail-too-large',
  'thumbnail-failed',
  'consumer-timeout',
  'invalid-request',
  'worker-failed',
];

/**
 * Validates the narrow cross-thread request before a decoder opens bytes. The
 * trusted host chooses the Blob; agents can only request scoped observations
 * through a higher-level service and never get this protocol directly.
 */
export function assertObservationWorkerRequest(
  value: unknown,
): asserts value is ObservationWorkerRequest {
  if (!isPlainRecord(value) || typeof value.type !== 'string')
    throw new RangeError('observation worker request must be a typed record');
  switch (value.type) {
    case 'decode-range':
      assertExactKeys(value, [
        'type',
        'jobId',
        'assetDigest',
        'streamId',
        'source',
        'epoch',
        'range',
        'thumbnail',
      ]);
      assertJobId(value.jobId);
      if (typeof value.assetDigest !== 'string' || !SHA_256.test(value.assetDigest))
        throw new RangeError('assetDigest must be a SHA-256 hex digest');
      if (typeof value.streamId !== 'string' || !STREAM_ID.test(value.streamId))
        throw new RangeError('streamId must be an opaque token');
      if (!(value.source instanceof Blob)) throw new TypeError('source must be a browser Blob');
      assertNonNegativeSafeInteger(value.epoch, 'epoch');
      assertRange(value.range);
      assertThumbnailBounds(value.thumbnail);
      return;
    case 'ack-frame':
      assertExactKeys(value, ['type', 'jobId', 'sequence']);
      assertJobId(value.jobId);
      assertNonNegativeSafeInteger(value.sequence, 'sequence');
      return;
    case 'cancel':
      assertExactKeys(value, ['type', 'jobId']);
      assertJobId(value.jobId);
      return;
    case 'set-playback-priority':
      assertExactKeys(value, ['type', 'active']);
      if (typeof value.active !== 'boolean')
        throw new TypeError('playback priority state must be boolean');
      return;
    default:
      throw new RangeError('observation worker request type is unsupported');
  }
}

export function isObservationWorkerResponse(value: unknown): value is ObservationWorkerResponse {
  try {
    assertObservationWorkerResponse(value);
    return true;
  } catch {
    return false;
  }
}

export function assertObservationWorkerResponse(
  value: unknown,
): asserts value is ObservationWorkerResponse {
  if (!isPlainRecord(value) || typeof value.type !== 'string')
    throw new RangeError('observation worker response must be a typed record');
  switch (value.type) {
    case 'frame':
      assertExactKeys(value, ['type', 'jobId', 'sequence', 'frame']);
      assertJobId(value.jobId);
      assertNonNegativeSafeInteger(value.sequence, 'sequence');
      assertDecodedFrame(value.frame);
      return;
    case 'complete':
      assertExactKeys(value, ['type', 'jobId', 'decodedFrameCount']);
      assertJobId(value.jobId);
      assertNonNegativeSafeInteger(value.decodedFrameCount, 'decodedFrameCount');
      return;
    case 'cancelled':
      assertExactKeys(value, ['type', 'jobId']);
      assertJobId(value.jobId);
      return;
    case 'failed':
      assertExactKeys(value, ['type', 'jobId', 'code']);
      assertJobId(value.jobId);
      if (
        typeof value.code !== 'string' ||
        !(FAILURE_CODES as readonly string[]).includes(value.code)
      )
        throw new RangeError('observation worker failure code is unsupported');
      return;
    default:
      throw new RangeError('observation worker response type is unsupported');
  }
}

export function createObservationWorkerJobId(sequence: number): string {
  assertNonNegativeSafeInteger(sequence, 'sequence');
  return `observation-${sequence}`;
}

function assertDecodedFrame(value: unknown): asserts value is ObservationWorkerDecodedFrame {
  if (!isPlainRecord(value)) throw new RangeError('decoded observation frame must be a record');
  assertExactKeys(value, [
    'id',
    'identity',
    'actualTimeUs',
    'durationUs',
    'presentationIndex',
    'width',
    'height',
    'thumbnail',
  ]);
  if (typeof value.id !== 'string')
    throw new RangeError('decoded observation frame id must be a string');
  assertFrameIdentity(value.identity);
  if (value.id !== frameIdentityKey(value.identity))
    throw new RangeError('decoded observation frame id must match its canonical identity');
  assertNonNegativeSafeInteger(value.actualTimeUs, 'actualTimeUs');
  assertNonNegativeSafeInteger(value.durationUs, 'durationUs');
  assertNonNegativeSafeInteger(value.presentationIndex, 'presentationIndex');
  assertPositiveSafeInteger(value.width, 'width');
  assertPositiveSafeInteger(value.height, 'height');
  if (
    value.actualTimeUs !== value.identity.sourceTimeUs ||
    value.durationUs !== value.identity.durationUs ||
    value.presentationIndex !== value.identity.presentationIndex
  )
    throw new RangeError('decoded observation frame timing must match its identity');
  assertThumbnail(value.thumbnail);
}

function assertThumbnail(value: unknown): asserts value is ObservationWorkerThumbnail {
  if (!isPlainRecord(value)) throw new RangeError('observation thumbnail must be a record');
  assertExactKeys(value, ['blob', 'width', 'height', 'byteLength', 'mimeType']);
  if (!(value.blob instanceof Blob)) throw new TypeError('observation thumbnail must carry a Blob');
  assertPositiveSafeInteger(value.width, 'thumbnail.width');
  assertPositiveSafeInteger(value.height, 'thumbnail.height');
  assertPositiveSafeInteger(value.byteLength, 'thumbnail.byteLength');
  if (value.width > 2_048 || value.height > 2_048 || value.byteLength > 8 * 1024 * 1024)
    throw new RangeError('observation thumbnail exceeds local worker bounds');
  if (value.blob.size !== value.byteLength)
    throw new RangeError('observation thumbnail byte length must match its Blob');
  if (
    (value.mimeType !== 'image/jpeg' && value.mimeType !== 'image/png') ||
    value.blob.type !== value.mimeType
  )
    throw new RangeError('observation thumbnail format must be an approved image type');
}

function assertRange(value: unknown): asserts value is SourceObservationRange {
  if (!isPlainRecord(value)) throw new RangeError('range must be a half-open record');
  assertExactKeys(value, ['startUs', 'endUs']);
  assertNonNegativeSafeInteger(value.startUs, 'range.startUs');
  assertNonNegativeSafeInteger(value.endUs, 'range.endUs');
  if (value.endUs <= value.startUs)
    throw new RangeError('range must be a non-empty half-open interval');
}

function assertThumbnailBounds(value: unknown): asserts value is ObservationThumbnailBounds {
  if (!isPlainRecord(value)) throw new RangeError('thumbnail bounds must be a record');
  assertExactKeys(value, ['maxWidth', 'maxHeight', 'maxBytes', 'mimeType', 'quality']);
  assertPositiveSafeInteger(value.maxWidth, 'thumbnail.maxWidth');
  assertPositiveSafeInteger(value.maxHeight, 'thumbnail.maxHeight');
  assertPositiveSafeInteger(value.maxBytes, 'thumbnail.maxBytes');
  if (
    value.maxWidth > 2_048 ||
    value.maxHeight > 2_048 ||
    value.maxBytes > 8 * 1024 * 1024 ||
    (value.mimeType !== 'image/jpeg' && value.mimeType !== 'image/png') ||
    typeof value.quality !== 'number' ||
    !Number.isFinite(value.quality) ||
    value.quality < 0 ||
    value.quality > 1
  )
    throw new RangeError('thumbnail bounds exceed local worker policy');
}

function assertJobId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !JOB_ID.test(value))
    throw new RangeError('jobId must be a bounded opaque identifier');
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be a non-negative safe integer`);
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${label} must be a positive safe integer`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value)];
  if (
    actual.length !== expected.length ||
    !expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
    throw new RangeError('observation worker message contains unsupported fields');
}
