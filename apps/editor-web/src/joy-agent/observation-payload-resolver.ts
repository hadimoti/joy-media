import type {
  EvidenceManifestLookup,
  EvidenceManifestScope,
  EvidenceStore,
} from '../media-observation/evidence-store.js';
import type {
  ObservationCache,
  ObservationCacheEntry,
  ObservationCacheIdentity,
} from '../media-observation/observation-cache.js';
import {
  MAX_MULTIMODAL_BATCH_EVIDENCE_BYTES,
  MAX_MULTIMODAL_EVIDENCE_BYTES,
  MAX_MULTIMODAL_EVIDENCE_PER_BATCH,
  type ObservationEvidencePayload,
} from './multimodal-transport.js';
import {
  MAX_OBSERVATION_CONSENT_RANGE_US,
  OBSERVATION_MODALITIES,
  type ObservationModality,
  type ObservationRange,
} from './observation-consent.js';
import type {
  ObservationTransferAuthority,
  ObservationTransferEvidenceResolver,
  ObservationTransferEvidenceResolverRequest,
} from './observation-transfer-service.js';

/**
 * The trusted main-thread record that links a metadata-only observation to
 * its bounded, derived frame cache. This is deliberately not part of the
 * Worker tool contract: it contains cache identity and MIME facts only, and
 * its resolver is the sole code path allowed to obtain a defensive byte copy.
 */
export interface ObservationPayloadRecord {
  readonly manifest: EvidenceManifestLookup;
  readonly authority: ObservationTransferAuthority;
  readonly range: {
    readonly startUs: number;
    readonly endUs: number;
  };
  readonly cacheIdentity: ObservationCacheIdentity;
  /** Exact MIME emitted by the local frame decoder for each decoded frame. */
  readonly frameMimeTypes: ReadonlyMap<string, 'image/jpeg' | 'image/png'>;
  /** Binds every temporal frame ID to its exact evidence manifest page. */
  readonly framePageById: ReadonlyMap<string, number>;
}

/**
 * A per-manifest host resolver. The manifest is intentionally bound before a
 * direct provider transfer begins, rather than supplied by a model or Worker
 * request. The Worker cannot reach this API through HostRpc.
 */
export interface CreateObservationTransferEvidenceResolverOptions {
  readonly manifest: EvidenceManifestLookup;
  readonly evidenceStore: Pick<EvidenceStore, 'readManifest' | 'readCoveragePage'>;
  readonly cache: Pick<ObservationCache, 'read'>;
  /** Reads the active host state; undefined means cancelled, terminal, or stale. */
  readonly currentAuthority: () => ObservationTransferAuthority | undefined;
  /** Returns only a private record for the exact bound manifest. */
  readonly readRecord: (manifest: EvidenceManifestLookup) => ObservationPayloadRecord | undefined;
}

const FRAME_ID = /^[A-Za-z0-9][A-Za-z0-9._:@=-]{0,511}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REVISION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/=-]{0,255}$/;
const SHA_256 = /^[a-f0-9]{64}$/i;
const UNSAFE_LOCATION = /(?:\b(?:https?|file|data|blob):|\b[A-Za-z]:|(?:^|\/)\.{1,2}(?:\/|$)|\\)/i;

/**
 * Builds a fail-closed, image-only resolver for one exact observation
 * manifest. It never reads a Blob, path, URL, original source, transcript,
 * audio, or native video. Cache reads yield defensive copies and those copies
 * are copied again before crossing the direct-provider boundary.
 */
export function createObservationTransferEvidenceResolver(
  rawOptions: CreateObservationTransferEvidenceResolverOptions,
): ObservationTransferEvidenceResolver {
  const options = normalizeOptions(rawOptions);
  if (options === undefined) return FAIL_CLOSED_RESOLVER;

  return Object.freeze({
    resolve(
      rawRequest: ObservationTransferEvidenceResolverRequest,
    ): readonly ObservationEvidencePayload[] | undefined {
      const request = normalizeRequest(rawRequest);
      if (request === undefined || request.signal.aborted) return undefined;

      const record = readExactRecord(options);
      if (
        record === undefined ||
        !sameAuthority(record.authority, request.authority) ||
        !sameAuthority(readCurrentAuthority(options), request.authority) ||
        request.range.domain !== 'source' ||
        !isRangeWithinRecord(request.range, record.range) ||
        !request.allowedModalities.includes('image')
      ) {
        return undefined;
      }

      const manifest = readCurrentManifest(options, record);
      if (manifest === undefined || request.signal.aborted) return undefined;

      const payloads: ObservationEvidencePayload[] = [];
      let totalBytes = 0;
      for (const evidenceId of request.evidenceIds) {
        if (request.signal.aborted) return undefined;
        const pageIndex = record.framePageById.get(evidenceId);
        const mimeType = record.frameMimeTypes.get(evidenceId);
        if (
          pageIndex === undefined ||
          !Number.isSafeInteger(pageIndex) ||
          pageIndex < 0 ||
          (mimeType !== 'image/jpeg' && mimeType !== 'image/png')
        ) {
          return undefined;
        }

        const page = readDecodedManifestPage(options, record, pageIndex);
        if (
          page === undefined ||
          !page.intendedFrameIds.includes(evidenceId) ||
          !page.decodedFrameIds.includes(evidenceId)
        ) {
          return undefined;
        }

        const cacheEntry = readExactCacheEntry(options, record, evidenceId);
        if (cacheEntry === undefined || cacheEntry.bytes.byteLength > MAX_MULTIMODAL_EVIDENCE_BYTES)
          return undefined;
        totalBytes += cacheEntry.bytes.byteLength;
        if (totalBytes > MAX_MULTIMODAL_BATCH_EVIDENCE_BYTES) return undefined;

        // A second copy prevents both a malformed cache implementation and a
        // future resolver consumer from retaining mutable cache-owned bytes.
        payloads.push(
          Object.freeze({
            evidenceId,
            modality: 'image' as const,
            mimeType,
            data: cacheEntry.bytes.slice(),
          }),
        );
      }

      if (
        request.signal.aborted ||
        !sameAuthority(readCurrentAuthority(options), request.authority)
      )
        return undefined;
      return Object.freeze(payloads);
    },
  });
}

const FAIL_CLOSED_RESOLVER: ObservationTransferEvidenceResolver = Object.freeze({
  resolve: () => undefined,
});

interface NormalizedOptions {
  readonly manifest: EvidenceManifestLookup;
  readonly evidenceStore: Pick<EvidenceStore, 'readManifest' | 'readCoveragePage'>;
  readonly cache: Pick<ObservationCache, 'read'>;
  readonly currentAuthority: () => ObservationTransferAuthority | undefined;
  readonly readRecord: (manifest: EvidenceManifestLookup) => ObservationPayloadRecord | undefined;
}

interface NormalizedRequest {
  readonly authority: ObservationTransferAuthority;
  readonly range: ObservationRange;
  readonly evidenceIds: readonly string[];
  readonly allowedModalities: readonly ObservationModality[];
  readonly signal: AbortSignal;
}

function normalizeOptions(
  value: CreateObservationTransferEvidenceResolverOptions,
): NormalizedOptions | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'manifest',
      'evidenceStore',
      'cache',
      'currentAuthority',
      'readRecord',
    ]) ||
    !isPlainRecord(value.evidenceStore) ||
    typeof value.evidenceStore.readManifest !== 'function' ||
    typeof value.evidenceStore.readCoveragePage !== 'function' ||
    !isPlainRecord(value.cache) ||
    typeof value.cache.read !== 'function' ||
    typeof value.currentAuthority !== 'function' ||
    typeof value.readRecord !== 'function'
  ) {
    return undefined;
  }
  const manifest = normalizeManifest(value.manifest);
  if (manifest === undefined) return undefined;
  return Object.freeze({
    manifest,
    evidenceStore: value.evidenceStore,
    cache: value.cache,
    currentAuthority: value.currentAuthority,
    readRecord: value.readRecord,
  });
}

function normalizeRequest(value: unknown): NormalizedRequest | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['authority', 'range', 'evidenceIds', 'allowedModalities', 'signal'])
  ) {
    return undefined;
  }
  const authority = normalizeAuthority(value.authority);
  const range = normalizeRange(value.range);
  const evidenceIds = normalizeEvidenceIds(value.evidenceIds);
  const allowedModalities = normalizeModalities(value.allowedModalities);
  if (
    authority === undefined ||
    range === undefined ||
    evidenceIds === undefined ||
    allowedModalities === undefined ||
    !isAbortSignal(value.signal)
  ) {
    return undefined;
  }
  return Object.freeze({ authority, range, evidenceIds, allowedModalities, signal: value.signal });
}

function readExactRecord(options: NormalizedOptions): ObservationPayloadRecord | undefined {
  try {
    const record = options.readRecord(options.manifest);
    if (
      record === undefined ||
      !isPlainRecord(record) ||
      !hasExactKeys(record, [
        'manifest',
        'authority',
        'range',
        'cacheIdentity',
        'frameMimeTypes',
        'framePageById',
      ]) ||
      !sameManifest(record.manifest, options.manifest) ||
      normalizeAuthority(record.authority) === undefined ||
      !isRecordRange(record.range) ||
      !isCacheIdentity(record.cacheIdentity) ||
      !isReadonlyMap(record.frameMimeTypes) ||
      !isReadonlyMap(record.framePageById) ||
      !isRecordScopeConsistent(record)
    ) {
      return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
}

function readCurrentAuthority(
  options: NormalizedOptions,
): ObservationTransferAuthority | undefined {
  try {
    return normalizeAuthority(options.currentAuthority());
  } catch {
    return undefined;
  }
}

function readCurrentManifest(
  options: NormalizedOptions,
  record: ObservationPayloadRecord,
): ReturnType<EvidenceStore['readManifest']> | undefined {
  try {
    const manifest = options.evidenceStore.readManifest(options.manifest);
    return manifest !== undefined &&
      (manifest.status === 'complete' || manifest.status === 'partial') &&
      sameManifest({ manifestId: manifest.id, scope: manifest.scope }, record.manifest)
      ? manifest
      : undefined;
  } catch {
    return undefined;
  }
}

function readDecodedManifestPage(
  options: NormalizedOptions,
  record: ObservationPayloadRecord,
  pageIndex: number,
): ReturnType<EvidenceStore['readCoveragePage']> | undefined {
  try {
    const page = options.evidenceStore.readCoveragePage({ ...record.manifest, pageIndex });
    return page !== undefined &&
      sameManifest({ manifestId: page.manifestId, scope: page.scope }, record.manifest)
      ? page
      : undefined;
  } catch {
    return undefined;
  }
}

function readExactCacheEntry(
  options: NormalizedOptions,
  record: ObservationPayloadRecord,
  evidenceId: string,
): ObservationCacheEntry | undefined {
  try {
    const entry = options.cache.read({
      identity: record.cacheIdentity,
      temporalFrameId: evidenceId,
    });
    if (
      entry === undefined ||
      !isPlainRecord(entry) ||
      !hasExactKeys(entry, ['identity', 'temporalFrameId', 'byteDigest', 'bytes']) ||
      entry.temporalFrameId !== evidenceId ||
      !sameCacheIdentity(entry.identity, record.cacheIdentity) ||
      typeof entry.byteDigest !== 'string' ||
      !SHA_256.test(entry.byteDigest) ||
      !(entry.bytes instanceof Uint8Array) ||
      entry.bytes.byteLength < 1
    ) {
      return undefined;
    }
    return Object.freeze({
      identity: cloneCacheIdentity(entry.identity),
      temporalFrameId: entry.temporalFrameId,
      byteDigest: entry.byteDigest.toLowerCase(),
      bytes: entry.bytes.slice(),
    });
  } catch {
    return undefined;
  }
}

function normalizeManifest(value: unknown): EvidenceManifestLookup | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['manifestId', 'scope'])) return undefined;
  if (!isFrameId(value.manifestId) || !isPlainRecord(value.scope)) return undefined;
  const scope = value.scope;
  if (
    !hasExactKeys(scope, ['runId', 'identity']) ||
    !isOpaqueId(scope.runId) ||
    !isPlainRecord(scope.identity)
  )
    return undefined;
  const identity = scope.identity;
  if (
    !hasExactKeys(identity, [
      'projectId',
      'assetDigest',
      'projectRevision',
      'modelId',
      'promptPolicyDigest',
    ]) ||
    !isOpaqueId(identity.projectId) ||
    typeof identity.assetDigest !== 'string' ||
    !SHA_256.test(identity.assetDigest) ||
    !isRevisionId(identity.projectRevision) ||
    !isOpaqueId(identity.modelId) ||
    !isOpaqueId(identity.promptPolicyDigest)
  ) {
    return undefined;
  }
  return Object.freeze({
    manifestId: value.manifestId,
    scope: Object.freeze({
      runId: scope.runId,
      identity: Object.freeze({
        projectId: identity.projectId,
        assetDigest: identity.assetDigest.toLowerCase(),
        projectRevision: identity.projectRevision,
        modelId: identity.modelId,
        promptPolicyDigest: identity.promptPolicyDigest,
      }),
    }),
  });
}

function normalizeAuthority(value: unknown): ObservationTransferAuthority | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['projectId', 'revision', 'run', 'modelId', 'promptPolicyDigest'])
  )
    return undefined;
  const run = value.run;
  if (!isPlainRecord(run) || !hasExactKeys(run, ['runId', 'epoch'])) return undefined;
  if (
    !isOpaqueId(value.projectId) ||
    !isRevisionId(value.revision) ||
    !isOpaqueId(run.runId) ||
    typeof run.epoch !== 'number' ||
    !Number.isSafeInteger(run.epoch) ||
    run.epoch < 1 ||
    !isOpaqueId(value.modelId) ||
    !isOpaqueId(value.promptPolicyDigest)
  ) {
    return undefined;
  }
  return Object.freeze({
    projectId: value.projectId,
    revision: value.revision,
    run: Object.freeze({ runId: run.runId, epoch: run.epoch }),
    modelId: value.modelId,
    promptPolicyDigest: value.promptPolicyDigest,
  });
}

function normalizeRange(value: unknown): ObservationRange | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['domain', 'startUs', 'endUs']))
    return undefined;
  const startUs = value.startUs;
  const endUs = value.endUs;
  if (
    (value.domain !== 'source' && value.domain !== 'composition') ||
    typeof startUs !== 'number' ||
    typeof endUs !== 'number' ||
    !Number.isSafeInteger(startUs) ||
    !Number.isSafeInteger(endUs) ||
    startUs < 0 ||
    endUs <= startUs ||
    endUs - startUs > MAX_OBSERVATION_CONSENT_RANGE_US
  ) {
    return undefined;
  }
  return Object.freeze({ domain: value.domain, startUs, endUs });
}

function normalizeEvidenceIds(value: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_MULTIMODAL_EVIDENCE_PER_BATCH ||
    value.some((id) => !isFrameId(id))
  ) {
    return undefined;
  }
  const ids = new Set(value);
  return ids.size === value.length ? Object.freeze([...value]) : undefined;
}

function normalizeModalities(value: unknown): readonly ObservationModality[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > OBSERVATION_MODALITIES.length ||
    value.some((item) => !isObservationModality(item))
  ) {
    return undefined;
  }
  const modalities = new Set(value);
  return modalities.size === value.length ? Object.freeze([...value]) : undefined;
}

function sameManifest(left: EvidenceManifestLookup, right: EvidenceManifestLookup): boolean {
  return left.manifestId === right.manifestId && sameScope(left.scope, right.scope);
}

function sameScope(left: EvidenceManifestScope, right: EvidenceManifestScope): boolean {
  return (
    left.runId === right.runId &&
    left.identity.projectId === right.identity.projectId &&
    left.identity.assetDigest.toLowerCase() === right.identity.assetDigest.toLowerCase() &&
    left.identity.projectRevision === right.identity.projectRevision &&
    left.identity.modelId === right.identity.modelId &&
    left.identity.promptPolicyDigest === right.identity.promptPolicyDigest
  );
}

function sameAuthority(
  left: ObservationTransferAuthority | undefined,
  right: ObservationTransferAuthority,
): boolean {
  return (
    left !== undefined &&
    left.projectId === right.projectId &&
    left.revision === right.revision &&
    left.run.runId === right.run.runId &&
    left.run.epoch === right.run.epoch &&
    left.modelId === right.modelId &&
    left.promptPolicyDigest === right.promptPolicyDigest
  );
}

function isRangeWithinRecord(
  range: ObservationRange,
  recordRange: ObservationPayloadRecord['range'],
): boolean {
  return range.startUs >= recordRange.startUs && range.endUs <= recordRange.endUs;
}

function isRecordRange(value: unknown): value is ObservationPayloadRecord['range'] {
  const startUs = isPlainRecord(value) ? value.startUs : undefined;
  const endUs = isPlainRecord(value) ? value.endUs : undefined;
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['startUs', 'endUs']) &&
    typeof startUs === 'number' &&
    typeof endUs === 'number' &&
    Number.isSafeInteger(startUs) &&
    Number.isSafeInteger(endUs) &&
    startUs >= 0 &&
    endUs > startUs &&
    endUs - startUs <= MAX_OBSERVATION_CONSENT_RANGE_US
  );
}

function isRecordScopeConsistent(record: ObservationPayloadRecord): boolean {
  const identity = record.manifest.scope.identity;
  return (
    record.manifest.scope.runId === record.authority.run.runId &&
    identity.projectId === record.authority.projectId &&
    identity.projectRevision === record.authority.revision &&
    identity.modelId === record.authority.modelId &&
    identity.promptPolicyDigest === record.authority.promptPolicyDigest &&
    record.cacheIdentity.projectId === identity.projectId &&
    record.cacheIdentity.assetDigest.toLowerCase() === identity.assetDigest.toLowerCase() &&
    record.cacheIdentity.projectRevision === identity.projectRevision &&
    record.cacheIdentity.modelId === identity.modelId &&
    record.cacheIdentity.promptPolicyDigest === identity.promptPolicyDigest
  );
}

function isCacheIdentity(value: unknown): value is ObservationCacheIdentity {
  const crop = isPlainRecord(value) && isPlainRecord(value.crop) ? value.crop : undefined;
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
    ]) ||
    !isOpaqueId(value.projectId) ||
    typeof value.assetDigest !== 'string' ||
    !SHA_256.test(value.assetDigest) ||
    !isRevisionId(value.projectRevision) ||
    !isOpaqueId(value.modelId) ||
    !isOpaqueId(value.promptPolicyDigest) ||
    !isOpaqueId(value.streamId) ||
    crop === undefined ||
    !hasExactKeys(crop, ['x', 'y', 'width', 'height']) ||
    typeof crop.x !== 'number' ||
    typeof crop.y !== 'number' ||
    typeof crop.width !== 'number' ||
    typeof crop.height !== 'number' ||
    !Number.isFinite(crop.x) ||
    !Number.isFinite(crop.y) ||
    !Number.isFinite(crop.width) ||
    !Number.isFinite(crop.height) ||
    crop.width <= 0 ||
    crop.height <= 0 ||
    (value.rotationDeg !== 0 &&
      value.rotationDeg !== 90 &&
      value.rotationDeg !== 180 &&
      value.rotationDeg !== 270) ||
    (value.representation !== 'original' && value.representation !== 'proxy') ||
    !isOpaqueId(value.analysisVersion)
  ) {
    return false;
  }
  return true;
}

function sameCacheIdentity(left: unknown, right: ObservationCacheIdentity): boolean {
  return (
    isCacheIdentity(left) &&
    left.projectId === right.projectId &&
    left.assetDigest.toLowerCase() === right.assetDigest.toLowerCase() &&
    left.projectRevision === right.projectRevision &&
    left.modelId === right.modelId &&
    left.promptPolicyDigest === right.promptPolicyDigest &&
    left.streamId === right.streamId &&
    left.crop.x === right.crop.x &&
    left.crop.y === right.crop.y &&
    left.crop.width === right.crop.width &&
    left.crop.height === right.crop.height &&
    left.rotationDeg === right.rotationDeg &&
    left.representation === right.representation &&
    left.analysisVersion === right.analysisVersion
  );
}

function cloneCacheIdentity(identity: ObservationCacheIdentity): ObservationCacheIdentity {
  return Object.freeze({
    projectId: identity.projectId,
    assetDigest: identity.assetDigest.toLowerCase(),
    projectRevision: identity.projectRevision,
    modelId: identity.modelId,
    promptPolicyDigest: identity.promptPolicyDigest,
    streamId: identity.streamId,
    crop: Object.freeze({ ...identity.crop }),
    rotationDeg: identity.rotationDeg,
    representation: identity.representation,
    analysisVersion: identity.analysisVersion,
  });
}

function isReadonlyMap(value: unknown): value is ReadonlyMap<unknown, unknown> {
  return value instanceof Map && typeof value.get === 'function';
}

function isAbortSignal(value: unknown): value is AbortSignal {
  const candidate = value as {
    readonly aborted?: unknown;
    readonly addEventListener?: unknown;
    readonly removeEventListener?: unknown;
  };
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof candidate.aborted === 'boolean' &&
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
  );
}

function isFrameId(value: unknown): value is string {
  return typeof value === 'string' && FRAME_ID.test(value) && !UNSAFE_LOCATION.test(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value) && !UNSAFE_LOCATION.test(value);
}

function isRevisionId(value: unknown): value is string {
  return typeof value === 'string' && REVISION_ID.test(value) && !UNSAFE_LOCATION.test(value);
}

function isObservationModality(value: unknown): value is ObservationModality {
  return typeof value === 'string' && OBSERVATION_MODALITIES.includes(value as ObservationModality);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value)];
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
