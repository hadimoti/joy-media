import { createObservationCacheKey, type ObservationCacheCrop } from '@joy-media/media-core';
import {
  EvidenceReviewActiveError,
  assertObservationEvidenceIdentity,
  sameObservationEvidenceIdentity,
  type ObservationEvidenceIdentity,
} from './evidence-store.js';

/**
 * Cache identity adds the exact source representation dimensions from O1 to
 * the project/revision/model/prompt-policy identity required by O3. A proxy,
 * crop, rotation, or analysis-version result can therefore never satisfy a
 * lookup for another source representation.
 */
export interface ObservationCacheIdentity extends ObservationEvidenceIdentity {
  readonly streamId: string;
  readonly crop: ObservationCacheCrop;
  readonly rotationDeg: 0 | 90 | 180 | 270;
  readonly representation: 'original' | 'proxy';
  readonly analysisVersion: string;
}

/** Cache keys retain temporal identity even when multiple frames share encoded bytes. */
export interface ObservationCacheWrite {
  readonly identity: ObservationCacheIdentity;
  readonly temporalFrameId: string;
  readonly byteDigest: string;
  readonly bytes: Uint8Array;
}

export interface ObservationCacheRead {
  readonly identity: ObservationCacheIdentity;
  readonly temporalFrameId: string;
}

export interface ObservationCacheEntry {
  readonly identity: ObservationCacheIdentity;
  readonly temporalFrameId: string;
  readonly byteDigest: string;
  /** A defensive copy. Callers cannot mutate cache-owned bytes. */
  readonly bytes: Uint8Array;
}

export interface ObservationCacheStats {
  readonly temporalIdentityCount: number;
  readonly uniqueByteEntryCount: number;
  readonly usedBytes: number;
  readonly maxBytes: number;
}

export interface ObservationCacheOptions {
  readonly maxBytes: number;
  /**
   * Lifecycle authority owned by the manifest store. It is deliberately not
   * supplied on each clear request, where an agent could forge a terminal
   * state. Without this guard, clearing fails closed.
   */
  readonly assertProjectClearable?: (projectId: string) => void;
}

/** Cache clearing is a user action; an active review must finish/cancel first. */
export interface ObservationCacheClearRequest {
  readonly projectId: string;
  readonly intent: 'user-request';
}

export interface ObservationCache {
  put(input: ObservationCacheWrite): void;
  /** Returns undefined rather than a result from a mismatched identity. */
  read(input: ObservationCacheRead): ObservationCacheEntry | undefined;
  stats(): ObservationCacheStats;
  clearProject(input: ObservationCacheClearRequest): {
    readonly clearedTemporalIdentityCount: number;
  };
}

export class ObservationCacheQuotaError extends Error {
  readonly code = 'JOY_OBSERVATION_CACHE_QUOTA_EXCEEDED' as const;

  constructor(
    readonly requestedBytes: number,
    readonly usedBytes: number,
    readonly maxBytes: number,
  ) {
    super('Observation cache quota exceeded.');
    this.name = 'ObservationCacheQuotaError';
  }
}

export class ObservationCacheIntegrityError extends Error {
  readonly code = 'JOY_OBSERVATION_CACHE_DIGEST_CONFLICT' as const;

  constructor(readonly byteDigest: string) {
    super('Observation cache byte digest conflicts with existing bytes.');
    this.name = 'ObservationCacheIntegrityError';
  }
}

const BYTE_DIGEST = /^[a-f0-9]{64}$/i;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@=-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:@=-]*)*$/;
const OPAQUE_FRAME_ID = /^[A-Za-z0-9][A-Za-z0-9._:@=-]{0,511}$/;
const UNSAFE_LOCATION = /(?:\b(?:https?|file|data|blob):|(?:^|\/)\.{1,2}(?:\/|$)|\\)/i;

interface StoredTemporalEntry {
  readonly identity: ObservationCacheIdentity;
  readonly temporalFrameId: string;
  readonly byteDigest: string;
}

interface StoredBytes {
  readonly bytes: Uint8Array;
  refCount: number;
}

/**
 * Ephemeral, evictable derived-byte cache. It intentionally has no API for
 * originals, project export, or durable persistence; future persistence must
 * remain an explicit user-controlled adapter above this core.
 */
export function createObservationCache(options: ObservationCacheOptions): ObservationCache {
  if (
    !isPlainRecord(options) ||
    !hasOnlyKeys(options, ['maxBytes', 'assertProjectClearable'], ['maxBytes'])
  )
    throw new RangeError(
      'observation cache options must contain only cache limits and a clear guard',
    );
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    throw new RangeError('maxBytes must be a non-negative safe integer');
  if (
    options.assertProjectClearable !== undefined &&
    typeof options.assertProjectClearable !== 'function'
  )
    throw new RangeError('assertProjectClearable must be a function when provided');

  const temporalEntries = new Map<string, StoredTemporalEntry>();
  const byteEntries = new Map<string, StoredBytes>();
  let usedBytes = 0;

  return {
    put(input) {
      const normalized = normalizeWrite(input);
      const temporalKey = temporalCacheKey(normalized.identity, normalized.temporalFrameId);
      const previous = temporalEntries.get(temporalKey);
      const existingBytes = byteEntries.get(normalized.byteDigest);
      if (existingBytes !== undefined && !sameBytes(existingBytes.bytes, normalized.bytes))
        throw new ObservationCacheIntegrityError(normalized.byteDigest);

      const releasedBytes =
        previous !== undefined &&
        previous.byteDigest !== normalized.byteDigest &&
        byteEntries.get(previous.byteDigest)?.refCount === 1
          ? byteEntries.get(previous.byteDigest)!.bytes.byteLength
          : 0;
      const requestedBytes = existingBytes === undefined ? normalized.bytes.byteLength : 0;
      const projectedBytes = usedBytes - releasedBytes + requestedBytes;
      if (projectedBytes > options.maxBytes)
        throw new ObservationCacheQuotaError(requestedBytes, usedBytes, options.maxBytes);

      if (previous !== undefined && previous.byteDigest !== normalized.byteDigest)
        releaseByteReference(byteEntries, previous.byteDigest, () => {
          usedBytes -= releasedBytes;
        });
      if (existingBytes === undefined) {
        byteEntries.set(normalized.byteDigest, { bytes: normalized.bytes.slice(), refCount: 1 });
        usedBytes += requestedBytes;
      } else if (previous === undefined || previous.byteDigest !== normalized.byteDigest) {
        existingBytes.refCount += 1;
      }
      // Never retain the caller's input buffer with every temporal identity.
      // Byte ownership is bounded solely by byteEntries above.
      temporalEntries.set(
        temporalKey,
        Object.freeze({
          identity: normalized.identity,
          temporalFrameId: normalized.temporalFrameId,
          byteDigest: normalized.byteDigest,
        }),
      );
    },
    read(input) {
      const normalized = normalizeRead(input);
      const entry = temporalEntries.get(
        temporalCacheKey(normalized.identity, normalized.temporalFrameId),
      );
      if (entry === undefined || !sameObservationCacheIdentity(entry.identity, normalized.identity))
        return undefined;
      const storedBytes = byteEntries.get(entry.byteDigest);
      if (storedBytes === undefined) return undefined;
      return Object.freeze({
        identity: cloneIdentity(entry.identity),
        temporalFrameId: entry.temporalFrameId,
        byteDigest: entry.byteDigest,
        bytes: storedBytes.bytes.slice(),
      });
    },
    stats() {
      return Object.freeze({
        temporalIdentityCount: temporalEntries.size,
        uniqueByteEntryCount: byteEntries.size,
        usedBytes,
        maxBytes: options.maxBytes,
      });
    },
    clearProject(input) {
      assertClearRequest(input);
      if (options.assertProjectClearable === undefined)
        throw new EvidenceReviewActiveError(input.projectId, Object.freeze([]));
      options.assertProjectClearable(input.projectId);
      const matches = [...temporalEntries.entries()].filter(
        ([, entry]) => entry.identity.projectId === input.projectId,
      );
      for (const [temporalKey, entry] of matches) {
        temporalEntries.delete(temporalKey);
        releaseByteReference(byteEntries, entry.byteDigest, (released) => {
          usedBytes -= released;
        });
      }
      return Object.freeze({ clearedTemporalIdentityCount: matches.length });
    },
  };
}

function normalizeWrite(
  input: ObservationCacheWrite,
): StoredTemporalEntry & { readonly bytes: Uint8Array } {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, ['identity', 'temporalFrameId', 'byteDigest', 'bytes'])
  )
    throw new RangeError('observation cache write must contain only bounded fields');
  assertObservationCacheIdentity(input.identity);
  assertTemporalFrameId(input.temporalFrameId);
  if (typeof input.byteDigest !== 'string' || !BYTE_DIGEST.test(input.byteDigest))
    throw new RangeError('byteDigest must be a SHA-256 hex digest');
  if (!(input.bytes instanceof Uint8Array)) throw new RangeError('bytes must be a Uint8Array');
  return Object.freeze({
    identity: cloneIdentity(input.identity),
    temporalFrameId: input.temporalFrameId,
    byteDigest: input.byteDigest.toLowerCase(),
    // Copy only after quota admission. A rejected oversized input must not
    // allocate another full byte buffer before it reports a quota error.
    bytes: input.bytes,
  });
}

function normalizeRead(input: ObservationCacheRead): ObservationCacheRead {
  if (!isPlainRecord(input) || !hasExactKeys(input, ['identity', 'temporalFrameId']))
    throw new RangeError('observation cache read must contain identity and temporalFrameId');
  assertObservationCacheIdentity(input.identity);
  assertTemporalFrameId(input.temporalFrameId);
  return Object.freeze({
    identity: cloneIdentity(input.identity),
    temporalFrameId: input.temporalFrameId,
  });
}

function cloneIdentity(identity: ObservationCacheIdentity): ObservationCacheIdentity {
  return Object.freeze({
    projectId: identity.projectId,
    assetDigest: identity.assetDigest.toLowerCase(),
    projectRevision: identity.projectRevision,
    modelId: identity.modelId,
    promptPolicyDigest: identity.promptPolicyDigest,
    streamId: identity.streamId,
    crop: Object.freeze({
      x: identity.crop.x,
      y: identity.crop.y,
      width: identity.crop.width,
      height: identity.crop.height,
    }),
    rotationDeg: identity.rotationDeg,
    representation: identity.representation,
    analysisVersion: identity.analysisVersion,
  });
}

function assertObservationCacheIdentity(value: unknown): asserts value is ObservationCacheIdentity {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'projectId',
      'assetDigest',
      'projectRevision',
      'modelId',
      'promptPolicyDigest',
      'streamId',
      'crop',
      'rotationDeg',
      'representation',
      'analysisVersion',
    ])
  )
    throw new RangeError('observation cache identity must contain only bounded fields');
  assertObservationEvidenceIdentity({
    projectId: value.projectId,
    assetDigest: value.assetDigest,
    projectRevision: value.projectRevision,
    modelId: value.modelId,
    promptPolicyDigest: value.promptPolicyDigest,
  });
  createObservationCacheKey({
    assetDigest: value.assetDigest as string,
    streamId: value.streamId as string,
    crop: value.crop as ObservationCacheCrop,
    rotationDeg: value.rotationDeg as 0 | 90 | 180 | 270,
    representation: value.representation as 'original' | 'proxy',
    modelId: value.modelId as string,
    analysisVersion: value.analysisVersion as string,
  });
}

function sameObservationCacheIdentity(
  left: ObservationCacheIdentity,
  right: ObservationCacheIdentity,
): boolean {
  return (
    sameObservationEvidenceIdentity(left, right) &&
    sourceRepresentationKey(left) === sourceRepresentationKey(right)
  );
}

function assertClearRequest(value: unknown): asserts value is ObservationCacheClearRequest {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['projectId', 'intent']))
    throw new RangeError('cache clear must be project-scoped and require user intent');
  assertOpaqueIdentifier(value.projectId, 'projectId');
  if (value.intent !== 'user-request')
    throw new RangeError('cache clear requires explicit user intent');
}

function releaseByteReference(
  entries: Map<string, StoredBytes>,
  byteDigest: string,
  onReleased: (releasedBytes: number) => void,
): void {
  const entry = entries.get(byteDigest);
  if (entry === undefined) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  entries.delete(byteDigest);
  onReleased(entry.bytes.byteLength);
}

function temporalCacheKey(identity: ObservationCacheIdentity, temporalFrameId: string): string {
  return [
    identity.projectId,
    identity.projectRevision,
    identity.promptPolicyDigest,
    sourceRepresentationKey(identity),
    temporalFrameId,
  ].join('\u0000');
}

function sourceRepresentationKey(identity: ObservationCacheIdentity): string {
  return createObservationCacheKey({
    assetDigest: identity.assetDigest,
    streamId: identity.streamId,
    crop: identity.crop,
    rotationDeg: identity.rotationDeg,
    representation: identity.representation,
    modelId: identity.modelId,
    analysisVersion: identity.analysisVersion,
  });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

function assertTemporalFrameId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !OPAQUE_FRAME_ID.test(value) || containsUnsafeLocation(value))
    throw new RangeError('temporalFrameId must be a bounded opaque source identity');
}

function assertOpaqueIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > 256 ||
    !OPAQUE_IDENTIFIER.test(value) ||
    containsUnsafeLocation(value)
  )
    throw new RangeError(`${label} must be a bounded opaque identifier`);
}

function containsUnsafeLocation(value: string): boolean {
  return UNSAFE_LOCATION.test(value);
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

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const actual = [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value)];
  return (
    actual.every((key) => typeof key === 'string' && allowed.includes(key)) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
