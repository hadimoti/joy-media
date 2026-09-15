import {
  createObservationCacheKey,
  assertFrameIdentity,
  frameIdentityKey,
  type ObservationCacheCrop,
} from '@joy-media/media-core';
import { MAX_OBSERVATION_CONSENT_RANGE_US } from '../joy-agent/observation-consent.js';
import type { HostRpcRun } from '../joy-agent/host-rpc.js';
import type {
  ProjectMediaObservationSource,
  ProjectMediaResolver,
} from '../project-media-resolver.js';
import {
  assertObservationEvidenceIdentity,
  type EvidenceManifestLookup,
  type EvidenceStore,
  type ObservationEvidenceIdentity,
} from './evidence-store.js';
import {
  ObservationCacheIntegrityError,
  ObservationCacheQuotaError,
  type ObservationCache,
  type ObservationCacheIdentity,
} from './observation-cache.js';
import type { ObservationWorkerClient } from './observation-worker-client.js';
import type { ObservationWorkerDecodedFrame } from './observation-protocol.js';
import type { SourceObservationRange } from './source-decoder.js';

/** Source transforms must stay explicit so a proxy is never labelled original detail. */
export interface ObservationSourceVariant {
  readonly crop: ObservationCacheCrop;
  readonly rotationDeg: 0 | 90 | 180 | 270;
  readonly representation: 'original' | 'proxy';
  readonly analysisVersion: string;
}

/**
 * Host-owned authority for one bounded local observation. It contains opaque
 * identity and budget facts only: no endpoint, key, URL, prompt, or model
 * response can cross this seam.
 */
export interface ObservationRunAuthority {
  readonly projectId: string;
  readonly run: HostRpcRun;
  readonly assetId: string;
  readonly assetDigest: string;
  readonly streamId: string;
  readonly projectRevision: string;
  readonly modelId: string;
  readonly promptPolicyDigest: string;
  readonly manifestId: string;
  readonly range: SourceObservationRange;
  readonly sourceVariant: ObservationSourceVariant;
  readonly maxFrames: number;
  readonly maxThumbnailBytes: number;
}

/** Host-only decoded artifact; outbound transport/consent stays above this layer. */
export interface ObservationHostFrame {
  readonly id: string;
  readonly actualTimeUs: number;
  readonly durationUs: number;
  readonly presentationIndex: number;
  readonly width: number;
  readonly height: number;
  readonly thumbnail: Blob;
  readonly thumbnailMimeType: 'image/jpeg' | 'image/png';
  readonly cacheHit: boolean;
}

export interface ObservationServiceOptions {
  readonly projectId: string;
  readonly resolver: Pick<ProjectMediaResolver, 'resolveObservationSource'>;
  readonly worker: Pick<ObservationWorkerClient, 'frames'>;
  readonly evidenceStore: EvidenceStore;
  readonly cache: ObservationCache;
  /** Reads the trusted controller's live run/epoch authority at every side effect. */
  readonly isAuthorityCurrent: (authority: ObservationRunAuthority) => boolean;
  /** Host-testable digest hook; production defaults to Web Crypto SHA-256. */
  readonly digestThumbnail?: (bytes: Uint8Array) => Promise<string>;
}

export interface ObservationService {
  observe(
    authority: ObservationRunAuthority,
    signal: AbortSignal,
  ): AsyncIterable<ObservationHostFrame>;
  /** Cancels only the exact active host run/epoch. */
  cancel(run: HostRpcRun): boolean;
}

export type ObservationServiceErrorCode =
  | 'cancelled'
  | 'stale-authority'
  | 'manifest-unavailable'
  | 'manifest-inactive'
  | 'source-unavailable'
  | 'noncanonical-frame'
  | 'unexpected-frame'
  | 'budget-exceeded'
  | 'digest-failed'
  | 'worker-failed'
  | 'invalid-authority';

/** A finite, redacted host diagnostic; raw decoder/resolver errors never escape. */
export class ObservationServiceError extends Error {
  constructor(readonly code: ObservationServiceErrorCode) {
    super(`JOY observation service failed: ${code}`);
    this.name = 'ObservationServiceError';
  }
}

const SHA_256 = /^[a-f0-9]{64}$/i;
const HOST_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@=-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:@=-]*)*$/;
const UNSAFE_LOCATION = /(?:\b(?:https?|file|data|blob):|\b[A-Za-z]:|(?:^|\/)\.{1,2}(?:\/|$)|\\)/i;
// Provider request caps (512 evidence IDs / 512 MiB) are not source-decoding
// caps: exhaustive local review can span many paged batches. These are
// host-side stream caps; the evidence store and cache enforce their own quotas.
const MAX_LOCAL_OBSERVATION_FRAMES = 2_097_152;
const MAX_LOCAL_OBSERVATION_THUMBNAIL_BYTES = 128 * 1024 * 1024;

interface ActiveObservation {
  readonly run: HostRpcRun;
  readonly controller: AbortController;
}

interface NormalizedAuthority {
  readonly authority: ObservationRunAuthority;
  readonly evidenceIdentity: ObservationEvidenceIdentity;
  readonly cacheIdentity: ObservationCacheIdentity;
  readonly manifestLookup: EvidenceManifestLookup;
}

/**
 * Trusted-host composition of exact decode, canonical frame identity, cache,
 * and paged evidence checkpoints. It intentionally does not call a provider
 * or expose an external location; transport requires the separate consent
 * path above this service.
 */
export function createObservationService(options: ObservationServiceOptions): ObservationService {
  const normalizedOptions = normalizeOptions(options);
  const activeByRunId = new Map<string, ActiveObservation>();

  const assertCurrent = (normalized: NormalizedAuthority, active: ActiveObservation): void => {
    if (active.controller.signal.aborted) throw new ObservationServiceError('cancelled');
    let current = false;
    try {
      current = normalizedOptions.isAuthorityCurrent(normalized.authority);
    } catch {
      current = false;
    }
    if (!current) throw new ObservationServiceError('stale-authority');
  };

  const assertManifestCurrent = (normalized: NormalizedAuthority): void => {
    const manifest = normalizedOptions.evidenceStore.readManifest(normalized.manifestLookup);
    if (manifest === undefined) throw new ObservationServiceError('manifest-unavailable');
    if (manifest.status !== 'running') throw new ObservationServiceError('manifest-inactive');
  };

  const activate = (normalized: NormalizedAuthority): ActiveObservation => {
    const incoming = normalized.authority.run;
    const previous = activeByRunId.get(incoming.runId);
    if (previous !== undefined) {
      if (previous.run.epoch >= incoming.epoch)
        throw new ObservationServiceError('stale-authority');
      previous.controller.abort();
    }
    const active: ActiveObservation = Object.freeze({
      run: Object.freeze({ runId: incoming.runId, epoch: incoming.epoch }),
      controller: new AbortController(),
    });
    activeByRunId.set(incoming.runId, active);
    return active;
  };

  return {
    async *observe(input, signal) {
      const normalized = normalizeAuthority(input, normalizedOptions.projectId);
      if (signal.aborted) throw new ObservationServiceError('cancelled');
      let initiallyCurrent = false;
      try {
        initiallyCurrent = normalizedOptions.isAuthorityCurrent(normalized.authority);
      } catch {
        initiallyCurrent = false;
      }
      if (!initiallyCurrent) throw new ObservationServiceError('stale-authority');
      const active = activate(normalized);
      const abortFromCaller = () => active.controller.abort();
      signal.addEventListener('abort', abortFromCaller, { once: true });
      // An AbortSignal may flip between the earlier check and listener setup.
      // AbortSignal does not replay an already-fired event for late listeners.
      if (signal.aborted) active.controller.abort();
      let decodedFrameCount = 0;
      let decodedThumbnailBytes = 0;
      const seenFrameIds = new Set<string>();

      try {
        assertCurrent(normalized, active);
        assertManifestCurrent(normalized);
        let source: ProjectMediaObservationSource;
        try {
          source = await normalizedOptions.resolver.resolveObservationSource(
            normalized.authority.assetId,
          );
        } catch {
          throw new ObservationServiceError('source-unavailable');
        }
        assertLocalObservationSource(source);
        assertCurrent(normalized, active);
        assertManifestCurrent(normalized);

        let stream: AsyncIterable<ObservationWorkerDecodedFrame>;
        try {
          stream = normalizedOptions.worker.frames(
            {
              assetDigest: normalized.authority.assetDigest,
              streamId: normalized.authority.streamId,
              source: source.blob,
              epoch: normalized.authority.run.epoch,
              range: normalized.authority.range,
            },
            active.controller.signal,
          );
        } catch {
          throw new ObservationServiceError('worker-failed');
        }

        for await (const frame of stream) {
          assertCurrent(normalized, active);
          assertCanonicalFrame(frame, normalized.authority);
          if (seenFrameIds.has(frame.id)) throw new ObservationServiceError('noncanonical-frame');
          seenFrameIds.add(frame.id);
          if (decodedFrameCount >= normalized.authority.maxFrames)
            throw new ObservationServiceError('budget-exceeded');
          if (
            frame.thumbnail.byteLength >
            normalized.authority.maxThumbnailBytes - decodedThumbnailBytes
          )
            throw new ObservationServiceError('budget-exceeded');

          let bytes: Uint8Array;
          try {
            bytes = new Uint8Array(await frame.thumbnail.blob.arrayBuffer());
          } catch {
            throw new ObservationServiceError('worker-failed');
          }
          if (bytes.byteLength !== frame.thumbnail.byteLength)
            throw new ObservationServiceError('noncanonical-frame');
          if (decodedThumbnailBytes + bytes.byteLength > normalized.authority.maxThumbnailBytes)
            throw new ObservationServiceError('budget-exceeded');
          assertCurrent(normalized, active);
          assertManifestCurrent(normalized);

          let byteDigest: string;
          try {
            byteDigest = await normalizedOptions.digestThumbnail(bytes);
          } catch {
            throw new ObservationServiceError('digest-failed');
          }
          if (!SHA_256.test(byteDigest)) throw new ObservationServiceError('digest-failed');
          // Digesting is asynchronous: recheck before the cache write so a
          // superseding project/run epoch cannot retain stale derived bytes.
          assertCurrent(normalized, active);
          assertManifestCurrent(normalized);

          const cached = normalizedOptions.cache.read({
            identity: normalized.cacheIdentity,
            temporalFrameId: frame.id,
          });
          const cacheHit =
            cached !== undefined &&
            cached.byteDigest.toLowerCase() === byteDigest.toLowerCase() &&
            sameBytes(cached.bytes, bytes);
          const thumbnailBytes = cacheHit ? cached.bytes : bytes;
          if (!cacheHit)
            normalizedOptions.cache.put({
              identity: normalized.cacheIdentity,
              temporalFrameId: frame.id,
              byteDigest,
              bytes,
            });

          assertCurrent(normalized, active);
          assertManifestCurrent(normalized);
          let recorded = false;
          try {
            recorded = normalizedOptions.evidenceStore.recordFrames({
              ...normalized.manifestLookup,
              stage: 'decoded',
              frameIds: [frame.id],
            });
          } catch {
            throw new ObservationServiceError('unexpected-frame');
          }
          if (!recorded) throw new ObservationServiceError('manifest-unavailable');

          decodedFrameCount += 1;
          decodedThumbnailBytes += bytes.byteLength;
          yield Object.freeze({
            id: frame.id,
            actualTimeUs: frame.actualTimeUs,
            durationUs: frame.durationUs,
            presentationIndex: frame.presentationIndex,
            width: frame.width,
            height: frame.height,
            thumbnail: new Blob([copyBytesToArrayBuffer(thumbnailBytes)], {
              type: frame.thumbnail.mimeType,
            }),
            thumbnailMimeType: frame.thumbnail.mimeType,
            cacheHit,
          });
        }
      } catch (error) {
        if (active.controller.signal.aborted || signal.aborted)
          throw new ObservationServiceError('cancelled');
        if (error instanceof ObservationServiceError) throw error;
        if (
          error instanceof ObservationCacheQuotaError ||
          error instanceof ObservationCacheIntegrityError
        )
          throw error;
        throw new ObservationServiceError('worker-failed');
      } finally {
        active.controller.abort();
        signal.removeEventListener('abort', abortFromCaller);
        if (activeByRunId.get(active.run.runId) === active) activeByRunId.delete(active.run.runId);
      }
    },
    cancel(run) {
      if (!isHostRun(run)) return false;
      const active = activeByRunId.get(run.runId);
      if (
        active === undefined ||
        active.run.epoch !== run.epoch ||
        active.controller.signal.aborted
      )
        return false;
      active.controller.abort();
      return true;
    },
  };
}

function normalizeOptions(options: ObservationServiceOptions): Required<ObservationServiceOptions> {
  if (
    !isPlainRecord(options) ||
    !hasOnlyKeys(
      options,
      [
        'projectId',
        'resolver',
        'worker',
        'evidenceStore',
        'cache',
        'isAuthorityCurrent',
        'digestThumbnail',
      ],
      ['projectId', 'resolver', 'worker', 'evidenceStore', 'cache', 'isAuthorityCurrent'],
    )
  )
    throw new ObservationServiceError('invalid-authority');
  assertOpaqueIdentifier(options.projectId, 'projectId');
  if (
    options.resolver === null ||
    typeof options.resolver !== 'object' ||
    typeof options.resolver.resolveObservationSource !== 'function' ||
    options.worker === null ||
    typeof options.worker !== 'object' ||
    typeof options.worker.frames !== 'function' ||
    options.evidenceStore === null ||
    typeof options.evidenceStore !== 'object' ||
    typeof options.evidenceStore.readManifest !== 'function' ||
    typeof options.evidenceStore.recordFrames !== 'function' ||
    options.cache === null ||
    typeof options.cache !== 'object' ||
    typeof options.cache.read !== 'function' ||
    typeof options.cache.put !== 'function' ||
    typeof options.isAuthorityCurrent !== 'function' ||
    (options.digestThumbnail !== undefined && typeof options.digestThumbnail !== 'function')
  )
    throw new ObservationServiceError('invalid-authority');
  return Object.freeze({
    ...options,
    digestThumbnail: options.digestThumbnail ?? digestWithWebCrypto,
  });
}

function normalizeAuthority(
  input: ObservationRunAuthority,
  expectedProjectId: string,
): NormalizedAuthority {
  try {
    if (
      !isPlainRecord(input) ||
      !hasExactKeys(input, [
        'projectId',
        'run',
        'assetId',
        'assetDigest',
        'streamId',
        'projectRevision',
        'modelId',
        'promptPolicyDigest',
        'manifestId',
        'range',
        'sourceVariant',
        'maxFrames',
        'maxThumbnailBytes',
      ]) ||
      input.projectId !== expectedProjectId
    )
      throw new Error();
    if (!isHostRun(input.run)) throw new Error();
    assertOpaqueIdentifier(input.assetId, 'assetId');
    assertOpaqueIdentifier(input.manifestId, 'manifestId');
    assertRange(input.range);
    if (
      !Number.isSafeInteger(input.maxFrames) ||
      input.maxFrames < 1 ||
      input.maxFrames > MAX_LOCAL_OBSERVATION_FRAMES ||
      !Number.isSafeInteger(input.maxThumbnailBytes) ||
      input.maxThumbnailBytes < 1 ||
      input.maxThumbnailBytes > MAX_LOCAL_OBSERVATION_THUMBNAIL_BYTES
    )
      throw new Error();

    const evidenceIdentity = Object.freeze({
      projectId: input.projectId,
      assetDigest: input.assetDigest.toLowerCase(),
      projectRevision: input.projectRevision,
      modelId: input.modelId,
      promptPolicyDigest: input.promptPolicyDigest,
    });
    assertObservationEvidenceIdentity(evidenceIdentity);
    const sourceVariant = normalizeSourceVariant(input.sourceVariant);
    const cacheIdentity: ObservationCacheIdentity = Object.freeze({
      ...evidenceIdentity,
      streamId: input.streamId,
      crop: sourceVariant.crop,
      rotationDeg: sourceVariant.rotationDeg,
      representation: sourceVariant.representation,
      analysisVersion: sourceVariant.analysisVersion,
    });
    // O1's canonical key is validation here, not an external or model-facing value.
    createObservationCacheKey({
      assetDigest: cacheIdentity.assetDigest,
      streamId: cacheIdentity.streamId,
      crop: cacheIdentity.crop,
      rotationDeg: cacheIdentity.rotationDeg,
      representation: cacheIdentity.representation,
      modelId: cacheIdentity.modelId,
      analysisVersion: cacheIdentity.analysisVersion,
    });
    const authority: ObservationRunAuthority = Object.freeze({
      projectId: evidenceIdentity.projectId,
      run: Object.freeze({ runId: input.run.runId, epoch: input.run.epoch }),
      assetId: input.assetId,
      assetDigest: evidenceIdentity.assetDigest,
      streamId: cacheIdentity.streamId,
      projectRevision: evidenceIdentity.projectRevision,
      modelId: evidenceIdentity.modelId,
      promptPolicyDigest: evidenceIdentity.promptPolicyDigest,
      manifestId: input.manifestId,
      range: Object.freeze({ startUs: input.range.startUs, endUs: input.range.endUs }),
      sourceVariant,
      maxFrames: input.maxFrames,
      maxThumbnailBytes: input.maxThumbnailBytes,
    });
    return Object.freeze({
      authority,
      evidenceIdentity,
      cacheIdentity,
      manifestLookup: Object.freeze({
        manifestId: authority.manifestId,
        scope: Object.freeze({ runId: authority.run.runId, identity: evidenceIdentity }),
      }),
    });
  } catch {
    throw new ObservationServiceError('invalid-authority');
  }
}

function normalizeSourceVariant(value: unknown): ObservationSourceVariant {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['crop', 'rotationDeg', 'representation', 'analysisVersion'])
  )
    throw new Error();
  // The shared canonical cache-key validator owns crop/rotation/representation
  // validation. Use a safe placeholder identity only for this local validation.
  const placeholderDigest = '0'.repeat(64);
  createObservationCacheKey({
    assetDigest: placeholderDigest,
    streamId: 'stream-0',
    crop: value.crop as ObservationCacheCrop,
    rotationDeg: value.rotationDeg as 0 | 90 | 180 | 270,
    representation: value.representation as 'original' | 'proxy',
    modelId: 'model-0',
    analysisVersion: value.analysisVersion as string,
  });
  return Object.freeze({
    crop: Object.freeze({
      x: (value.crop as ObservationCacheCrop).x,
      y: (value.crop as ObservationCacheCrop).y,
      width: (value.crop as ObservationCacheCrop).width,
      height: (value.crop as ObservationCacheCrop).height,
    }),
    rotationDeg: value.rotationDeg as 0 | 90 | 180 | 270,
    representation: value.representation as 'original' | 'proxy',
    analysisVersion: value.analysisVersion as string,
  });
}

function assertCanonicalFrame(
  frame: ObservationWorkerDecodedFrame,
  authority: ObservationRunAuthority,
): void {
  try {
    if (!isPlainRecord(frame)) throw new Error();
    assertFrameIdentity(frame.identity);
    if (
      frame.id !== frameIdentityKey(frame.identity) ||
      frame.identity.assetDigest.toLowerCase() !== authority.assetDigest ||
      frame.identity.streamId !== authority.streamId ||
      frame.actualTimeUs !== frame.identity.sourceTimeUs ||
      frame.durationUs !== frame.identity.durationUs ||
      frame.presentationIndex !== frame.identity.presentationIndex ||
      !Number.isSafeInteger(frame.actualTimeUs) ||
      !Number.isSafeInteger(frame.durationUs) ||
      !Number.isSafeInteger(frame.width) ||
      !Number.isSafeInteger(frame.height) ||
      frame.actualTimeUs < 0 ||
      frame.durationUs < 0 ||
      frame.width < 1 ||
      frame.height < 1 ||
      !intersectsRange(frame.actualTimeUs, frame.durationUs, authority.range) ||
      !isValidThumbnail(frame.thumbnail)
    )
      throw new Error();
  } catch {
    throw new ObservationServiceError('noncanonical-frame');
  }
}

function assertLocalObservationSource(
  value: unknown,
): asserts value is ProjectMediaObservationSource {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['blob', 'mimeType', 'source']) ||
    !(value.blob instanceof Blob) ||
    typeof value.mimeType !== 'string' ||
    (value.source !== 'opfs' && value.source !== 'cloud')
  )
    throw new ObservationServiceError('source-unavailable');
}

function assertRange(value: unknown): asserts value is SourceObservationRange {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['startUs', 'endUs'])) throw new Error();
  const { startUs, endUs } = value;
  if (
    typeof startUs !== 'number' ||
    typeof endUs !== 'number' ||
    !Number.isSafeInteger(startUs) ||
    !Number.isSafeInteger(endUs) ||
    startUs < 0 ||
    endUs <= startUs ||
    endUs - startUs > MAX_OBSERVATION_CONSENT_RANGE_US
  )
    throw new Error();
}

function isHostRun(value: unknown): value is HostRpcRun {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['runId', 'epoch'])) return false;
  const { runId, epoch } = value;
  return (
    typeof runId === 'string' &&
    HOST_RUN_ID.test(runId) &&
    typeof epoch === 'number' &&
    Number.isSafeInteger(epoch) &&
    epoch >= 1
  );
}

function isValidThumbnail(value: unknown): value is ObservationWorkerDecodedFrame['thumbnail'] {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['blob', 'width', 'height', 'byteLength', 'mimeType'])
  )
    return false;
  const { blob, width, height, byteLength, mimeType } = value;
  return (
    blob instanceof Blob &&
    typeof width === 'number' &&
    Number.isSafeInteger(width) &&
    width > 0 &&
    typeof height === 'number' &&
    Number.isSafeInteger(height) &&
    height > 0 &&
    typeof byteLength === 'number' &&
    Number.isSafeInteger(byteLength) &&
    byteLength > 0 &&
    byteLength === blob.size &&
    (mimeType === 'image/jpeg' || mimeType === 'image/png') &&
    blob.type === mimeType
  );
}

function intersectsRange(
  startUs: number,
  durationUs: number,
  range: SourceObservationRange,
): boolean {
  if (durationUs === 0) return startUs >= range.startUs && startUs < range.endUs;
  return startUs < range.endUs && startUs + durationUs > range.startUs;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

async function digestWithWebCrypto(bytes: Uint8Array): Promise<string> {
  if (typeof crypto === 'undefined' || crypto.subtle === undefined)
    throw new ObservationServiceError('digest-failed');
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', copyBytesToArrayBuffer(bytes)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The DOM Blob/Crypto APIs require an ArrayBuffer-backed view. Cache values may
 * be typed as ArrayBufferLike, so make a bounded defensive copy at this
 * host-only boundary rather than relying on a SharedArrayBuffer-compatible cast.
 */
function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function assertOpaqueIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > 256 ||
    !OPAQUE_IDENTIFIER.test(value) ||
    UNSAFE_LOCATION.test(value)
  )
    throw new RangeError(`${label} must be a bounded opaque identifier`);
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
