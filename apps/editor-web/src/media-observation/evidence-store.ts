import type { EvidenceCoverageStatus, ObservationMode } from '@joy-media/media-core';

/** Public manifest queries never expose more than this many temporal identities at once. */
export const MAX_EVIDENCE_MANIFEST_FRAME_IDS_PER_PAGE = 512;

export type EvidencePersistencePreference = 'ephemeral' | 'project-local-metadata';
export type EvidenceFrameStage = 'decoded' | 'submitted' | 'reviewed';
export type EvidenceDerivedMetadataValue = string | number | boolean | null;

/**
 * Every reusable observation result is tied to all inputs that could change its
 * meaning. Source bytes alone are not sufficient identity for a model result.
 */
export interface ObservationEvidenceIdentity {
  readonly projectId: string;
  readonly assetDigest: string;
  readonly projectRevision: string;
  readonly modelId: string;
  readonly promptPolicyDigest: string;
}

/** A review run owns one or more manifests while it is active. */
export interface EvidenceManifestScope {
  readonly runId: string;
  readonly identity: ObservationEvidenceIdentity;
}

export interface CreateEvidenceManifestInput {
  readonly id: string;
  readonly scope: EvidenceManifestScope;
  readonly mode: ObservationMode;
  /**
   * The caller supplies bounded pages instead of one unbounded feature-length
   * array. IDs are temporal identities, not byte hashes.
   */
  readonly intendedFrameIdPages: readonly (readonly string[])[];
  /** Defaults to ephemeral. This setting is metadata-only; no original media is accepted here. */
  readonly persistence?: EvidencePersistencePreference;
  readonly derivedMetadata?: Readonly<Record<string, EvidenceDerivedMetadataValue>>;
}

export interface EvidenceManifest {
  readonly id: string;
  readonly scope: EvidenceManifestScope;
  readonly mode: ObservationMode;
  readonly status: EvidenceCoverageStatus;
  readonly persistence: EvidencePersistencePreference;
  readonly derivedMetadata: Readonly<Record<string, EvidenceDerivedMetadataValue>>;
  readonly pageCount: number;
  readonly intendedFrameCount: number;
  readonly decodedFrameCount: number;
  readonly submittedFrameCount: number;
  readonly reviewedFrameCount: number;
}

export interface EvidenceManifestCoverageSummary {
  readonly intendedFrameCount: number;
  readonly decodedFrameCount: number;
  readonly submittedFrameCount: number;
  readonly reviewedFrameCount: number;
  readonly exhaustiveInput: boolean;
  /** Evidence input is never a claim that a model understood every frame. */
  readonly modelComprehensionGuaranteed: false;
}

export interface EvidenceManifestCoveragePage {
  readonly manifestId: string;
  readonly scope: EvidenceManifestScope;
  readonly mode: ObservationMode;
  readonly status: EvidenceCoverageStatus;
  readonly pageIndex: number;
  readonly pageCount: number;
  readonly intendedFrameIds: readonly string[];
  readonly decodedFrameIds: readonly string[];
  readonly submittedFrameIds: readonly string[];
  readonly reviewedFrameIds: readonly string[];
  readonly summary: EvidenceManifestCoverageSummary;
}

export interface EvidenceManifestLookup {
  readonly manifestId: string;
  readonly scope: EvidenceManifestScope;
}

export interface RecordEvidenceFramesInput extends EvidenceManifestLookup {
  readonly stage: EvidenceFrameStage;
  readonly frameIds: readonly string[];
}

export interface SetEvidenceManifestStatusInput extends EvidenceManifestLookup {
  readonly status: EvidenceCoverageStatus;
}

export interface ReadEvidenceCoveragePageInput extends EvidenceManifestLookup {
  readonly pageIndex: number;
}

/** Only a user-triggered, project-scoped command may clear derived analysis. */
export interface UserEvidenceClearRequest {
  readonly projectId: string;
  readonly intent: 'user-request';
}

export interface EvidenceStoreOptions {
  readonly maxManifestCount?: number;
  readonly maxPagesPerManifest?: number;
  readonly maxFramesPerManifest?: number;
}

export interface EvidenceStore {
  createManifest(input: CreateEvidenceManifestInput): EvidenceManifest;
  readManifest(input: EvidenceManifestLookup): EvidenceManifest | undefined;
  readCoveragePage(input: ReadEvidenceCoveragePageInput): EvidenceManifestCoveragePage | undefined;
  /** Returns false for a stale/missing scope without changing stored evidence. */
  recordFrames(input: RecordEvidenceFramesInput): boolean;
  /** Returns false for a stale/missing scope without changing stored evidence. */
  setStatus(input: SetEvidenceManifestStatusInput): boolean;
  /**
   * Reusable authoritative lifecycle guard for derived-byte adapters. It does
   * not clear anything, so a cache cannot self-report a run as terminal.
   */
  assertProjectClearable(projectId: string): void;
  clearProject(input: UserEvidenceClearRequest): { readonly clearedManifestCount: number };
}

export class EvidenceStoreQuotaError extends Error {
  readonly code = 'JOY_EVIDENCE_QUOTA_EXCEEDED' as const;

  constructor(
    readonly quota: 'manifest-count' | 'page-count' | 'frame-count',
    readonly limit: number,
    readonly current: number,
    readonly requested: number,
  ) {
    super(`Evidence ${quota} quota exceeded.`);
    this.name = 'EvidenceStoreQuotaError';
  }
}

export class EvidenceReviewActiveError extends Error {
  readonly code = 'JOY_EVIDENCE_REVIEW_ACTIVE' as const;

  constructor(
    readonly projectId: string,
    readonly activeManifestIds: readonly string[],
  ) {
    super('Derived evidence cannot be cleared while a review is active.');
    this.name = 'EvidenceReviewActiveError';
  }
}

const DEFAULT_MAX_MANIFEST_COUNT = 64;
const DEFAULT_MAX_PAGES_PER_MANIFEST = 4_096;
const DEFAULT_MAX_FRAMES_PER_MANIFEST =
  DEFAULT_MAX_PAGES_PER_MANIFEST * MAX_EVIDENCE_MANIFEST_FRAME_IDS_PER_PAGE;
const MAX_DERIVED_METADATA_ENTRIES = 64;
const MAX_DERIVED_METADATA_STRING_LENGTH = 512;
const ASSET_DIGEST = /^[a-f0-9]{64}$/i;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@=-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:@=-]*)*$/;
const OPAQUE_FRAME_ID = /^[A-Za-z0-9][A-Za-z0-9._:@=-]{0,511}$/;
const OPAQUE_METADATA_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UNSAFE_LOCATION = /(?:\b(?:https?|file|data|blob):|(?:^|\/)\.{1,2}(?:\/|$)|\\)/i;
const OBSERVATION_MODES: readonly ObservationMode[] = [
  'overview',
  'focus',
  'exhaustive',
  'provider-video',
];
const COVERAGE_STATUSES: readonly EvidenceCoverageStatus[] = [
  'running',
  'complete',
  'partial',
  'failed',
  'cancelled',
];

interface MutableEvidenceManifestPage {
  readonly intendedFrameIds: readonly string[];
  readonly decodedFrameIds: Set<string>;
  readonly submittedFrameIds: Set<string>;
  readonly reviewedFrameIds: Set<string>;
}

interface MutableEvidenceManifest {
  readonly id: string;
  readonly scope: EvidenceManifestScope;
  readonly mode: ObservationMode;
  readonly persistence: EvidencePersistencePreference;
  readonly derivedMetadata: Readonly<Record<string, EvidenceDerivedMetadataValue>>;
  readonly pages: readonly MutableEvidenceManifestPage[];
  readonly framePageById: ReadonlyMap<string, number>;
  status: EvidenceCoverageStatus;
  decodedFrameCount: number;
  submittedFrameCount: number;
  reviewedFrameCount: number;
}

/**
 * Bounded in-memory manifest core. A future IndexedDB/OPFS adapter can persist
 * only manifests whose explicit preference is `project-local-metadata`; this
 * core deliberately never accepts original media or provider credentials.
 */
export function createEvidenceStore(options: EvidenceStoreOptions = {}): EvidenceStore {
  const limits = normalizeLimits(options);
  const manifests = new Map<string, MutableEvidenceManifest>();

  return {
    createManifest(input) {
      const manifest = normalizeManifestInput(input, limits);
      if (manifests.has(manifest.id)) throw new RangeError('evidence manifest id already exists');
      if (manifests.size >= limits.maxManifestCount)
        throw new EvidenceStoreQuotaError(
          'manifest-count',
          limits.maxManifestCount,
          manifests.size,
          1,
        );
      manifests.set(manifest.id, manifest);
      return snapshotManifest(manifest);
    },
    readManifest(input) {
      const manifest = getScopedManifest(manifests, input);
      return manifest === undefined ? undefined : snapshotManifest(manifest);
    },
    readCoveragePage(input) {
      const manifest = getScopedManifest(manifests, input);
      if (manifest === undefined) return undefined;
      assertPageIndex(input.pageIndex);
      const page = manifest.pages[input.pageIndex];
      if (page === undefined) return undefined;
      const copyFor = (frameIds: ReadonlySet<string>): readonly string[] =>
        Object.freeze(page.intendedFrameIds.filter((frameId) => frameIds.has(frameId)));
      return Object.freeze({
        manifestId: manifest.id,
        scope: cloneScope(manifest.scope),
        mode: manifest.mode,
        status: manifest.status,
        pageIndex: input.pageIndex,
        pageCount: manifest.pages.length,
        intendedFrameIds: Object.freeze([...page.intendedFrameIds]),
        decodedFrameIds: copyFor(page.decodedFrameIds),
        submittedFrameIds: copyFor(page.submittedFrameIds),
        reviewedFrameIds: copyFor(page.reviewedFrameIds),
        summary: coverageSummary(manifest),
      });
    },
    recordFrames(input) {
      const manifest = getScopedManifest(manifests, input);
      if (manifest === undefined) return false;
      assertEvidenceFrameStage(input.stage);
      const frameIds = normalizeFrameIdPage(input.frameIds, 'frameIds');
      const pages = frameIds.map((frameId) => {
        const pageIndex = manifest.framePageById.get(frameId);
        if (pageIndex === undefined)
          throw new RangeError('frame id is not intended by this manifest');
        return manifest.pages[pageIndex]!;
      });
      if (
        input.stage === 'reviewed' &&
        pages.some((page, index) => !page.submittedFrameIds.has(frameIds[index]!))
      )
        throw new RangeError('reviewed frames must have been submitted first');

      for (const [index, frameId] of frameIds.entries()) {
        const page = pages[index]!;
        const destination = page[`${input.stage}FrameIds`];
        if (destination.has(frameId)) continue;
        destination.add(frameId);
        if (input.stage === 'decoded') manifest.decodedFrameCount += 1;
        if (input.stage === 'submitted') manifest.submittedFrameCount += 1;
        if (input.stage === 'reviewed') manifest.reviewedFrameCount += 1;
      }
      return true;
    },
    setStatus(input) {
      const manifest = getScopedManifest(manifests, input);
      if (manifest === undefined) return false;
      assertEvidenceCoverageStatus(input.status);
      if (manifest.status !== 'running' && input.status === 'running')
        throw new RangeError('a terminal evidence manifest cannot resume as running');
      manifest.status = input.status;
      return true;
    },
    assertProjectClearable(projectId) {
      assertProjectHasNoActiveReview(manifests, projectId);
    },
    clearProject(input) {
      assertUserClearRequest(input);
      const scoped = [...manifests.values()].filter(
        (manifest) => manifest.scope.identity.projectId === input.projectId,
      );
      assertProjectHasNoActiveReview(manifests, input.projectId);
      for (const manifest of scoped) manifests.delete(manifest.id);
      return Object.freeze({ clearedManifestCount: scoped.length });
    },
  };
}

/** Shared identity validator for the byte cache and future evidence adapters. */
export function assertObservationEvidenceIdentity(
  value: unknown,
): asserts value is ObservationEvidenceIdentity {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'projectId',
      'assetDigest',
      'projectRevision',
      'modelId',
      'promptPolicyDigest',
    ])
  )
    throw new RangeError('observation identity must contain only bounded fields');
  assertOpaqueIdentifier(value.projectId, 'projectId');
  if (typeof value.assetDigest !== 'string' || !ASSET_DIGEST.test(value.assetDigest))
    throw new RangeError('assetDigest must be a SHA-256 hex digest');
  assertOpaqueIdentifier(value.projectRevision, 'projectRevision');
  assertOpaqueIdentifier(value.modelId, 'modelId');
  assertOpaqueIdentifier(value.promptPolicyDigest, 'promptPolicyDigest');
}

export function sameObservationEvidenceIdentity(
  left: ObservationEvidenceIdentity,
  right: ObservationEvidenceIdentity,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.assetDigest.toLowerCase() === right.assetDigest.toLowerCase() &&
    left.projectRevision === right.projectRevision &&
    left.modelId === right.modelId &&
    left.promptPolicyDigest === right.promptPolicyDigest
  );
}

function normalizeLimits(options: EvidenceStoreOptions): Required<EvidenceStoreOptions> {
  if (!isPlainRecord(options))
    throw new RangeError('evidence store options must be a plain record');
  return {
    maxManifestCount: normalizeLimit(
      options.maxManifestCount,
      DEFAULT_MAX_MANIFEST_COUNT,
      'maxManifestCount',
    ),
    maxPagesPerManifest: normalizeLimit(
      options.maxPagesPerManifest,
      DEFAULT_MAX_PAGES_PER_MANIFEST,
      'maxPagesPerManifest',
    ),
    maxFramesPerManifest: normalizeLimit(
      options.maxFramesPerManifest,
      DEFAULT_MAX_FRAMES_PER_MANIFEST,
      'maxFramesPerManifest',
    ),
  };
}

function normalizeLimit(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${label} must be positive`);
  return value;
}

function normalizeManifestInput(
  input: CreateEvidenceManifestInput,
  limits: Required<EvidenceStoreOptions>,
): MutableEvidenceManifest {
  if (
    !isPlainRecord(input) ||
    !hasOnlyKeys(
      input,
      ['id', 'scope', 'mode', 'intendedFrameIdPages', 'persistence', 'derivedMetadata'],
      ['id', 'scope', 'mode', 'intendedFrameIdPages'],
    )
  )
    throw new RangeError('evidence manifest must contain only metadata fields');
  assertOpaqueIdentifier(input.id, 'manifest id');
  const scope = normalizeScope(input.scope);
  assertObservationMode(input.mode);
  const persistence = input.persistence ?? 'ephemeral';
  if (persistence !== 'ephemeral' && persistence !== 'project-local-metadata')
    throw new RangeError('persistence must be ephemeral or project-local-metadata');
  const preparedPages = normalizeManifestPages(input.intendedFrameIdPages, limits);
  return {
    id: input.id,
    scope,
    mode: input.mode,
    status: 'running',
    persistence,
    derivedMetadata: normalizeDerivedMetadata(input.derivedMetadata),
    pages: preparedPages.pages,
    framePageById: preparedPages.framePageById,
    decodedFrameCount: 0,
    submittedFrameCount: 0,
    reviewedFrameCount: 0,
  };
}

function normalizeManifestPages(
  value: unknown,
  limits: Required<EvidenceStoreOptions>,
): {
  readonly pages: readonly MutableEvidenceManifestPage[];
  readonly framePageById: ReadonlyMap<string, number>;
} {
  if (!Array.isArray(value))
    throw new RangeError('intendedFrameIdPages must be an array of bounded pages');
  if (value.length > limits.maxPagesPerManifest)
    throw new EvidenceStoreQuotaError('page-count', limits.maxPagesPerManifest, 0, value.length);
  const framePageById = new Map<string, number>();
  const pages: MutableEvidenceManifestPage[] = [];
  let frameCount = 0;
  for (const [pageIndex, page] of value.entries()) {
    const frameIds = normalizeFrameIdPage(page, `intendedFrameIdPages[${pageIndex}]`);
    if (frameIds.length === 0) throw new RangeError('evidence manifest pages must not be empty');
    frameCount += frameIds.length;
    if (frameCount > limits.maxFramesPerManifest)
      throw new EvidenceStoreQuotaError(
        'frame-count',
        limits.maxFramesPerManifest,
        frameCount - frameIds.length,
        frameIds.length,
      );
    for (const frameId of frameIds) {
      if (framePageById.has(frameId))
        throw new RangeError(`duplicate intended frame id: ${frameId}`);
      framePageById.set(frameId, pageIndex);
    }
    pages.push({
      intendedFrameIds: Object.freeze(frameIds),
      decodedFrameIds: new Set(),
      submittedFrameIds: new Set(),
      reviewedFrameIds: new Set(),
    });
  }
  return { pages: Object.freeze(pages), framePageById };
}

function normalizeFrameIdPage(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_MANIFEST_FRAME_IDS_PER_PAGE)
    throw new RangeError(`${label} must be a bounded frame identity page`);
  const seen = new Set<string>();
  const frameIds: string[] = [];
  for (const frameId of value) {
    assertFrameId(frameId, label);
    if (seen.has(frameId)) throw new RangeError(`${label} must not repeat a frame identity`);
    seen.add(frameId);
    frameIds.push(frameId);
  }
  return frameIds;
}

function normalizeDerivedMetadata(
  value: CreateEvidenceManifestInput['derivedMetadata'],
): Readonly<Record<string, EvidenceDerivedMetadataValue>> {
  if (value === undefined) return Object.freeze({});
  if (!isPlainRecord(value))
    throw new RangeError('derivedMetadata must be a plain metadata record');
  const entries = Object.entries(value);
  if (entries.length > MAX_DERIVED_METADATA_ENTRIES)
    throw new RangeError('derivedMetadata exceeds the bounded metadata entry count');
  const copy: Record<string, EvidenceDerivedMetadataValue> = {};
  for (const [key, item] of entries) {
    if (!OPAQUE_METADATA_KEY.test(key)) throw new RangeError('derivedMetadata keys must be opaque');
    if (
      item !== null &&
      typeof item !== 'boolean' &&
      (typeof item !== 'number' || !Number.isFinite(item)) &&
      (typeof item !== 'string' || item.length > MAX_DERIVED_METADATA_STRING_LENGTH)
    )
      throw new RangeError('derivedMetadata values must be bounded primitive values');
    copy[key] = item;
  }
  return Object.freeze(copy);
}

function getScopedManifest<T extends EvidenceManifestLookup>(
  manifests: ReadonlyMap<string, MutableEvidenceManifest>,
  input: T,
): MutableEvidenceManifest | undefined {
  if (!isPlainRecord(input)) throw new RangeError('evidence lookup must be a plain record');
  assertOpaqueIdentifier(input.manifestId, 'manifest id');
  const scope = normalizeScope(input.scope);
  const manifest = manifests.get(input.manifestId);
  return manifest === undefined || !sameScope(manifest.scope, scope) ? undefined : manifest;
}

function normalizeScope(value: unknown): EvidenceManifestScope {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['runId', 'identity']))
    throw new RangeError('evidence scope must contain runId and identity');
  assertOpaqueIdentifier(value.runId, 'runId');
  assertObservationEvidenceIdentity(value.identity);
  return Object.freeze({
    runId: value.runId,
    identity: normalizeIdentity(value.identity),
  });
}

function normalizeIdentity(identity: ObservationEvidenceIdentity): ObservationEvidenceIdentity {
  return Object.freeze({
    projectId: identity.projectId,
    assetDigest: identity.assetDigest.toLowerCase(),
    projectRevision: identity.projectRevision,
    modelId: identity.modelId,
    promptPolicyDigest: identity.promptPolicyDigest,
  });
}

function cloneScope(scope: EvidenceManifestScope): EvidenceManifestScope {
  return Object.freeze({ runId: scope.runId, identity: normalizeIdentity(scope.identity) });
}

function sameScope(left: EvidenceManifestScope, right: EvidenceManifestScope): boolean {
  return (
    left.runId === right.runId && sameObservationEvidenceIdentity(left.identity, right.identity)
  );
}

function snapshotManifest(manifest: MutableEvidenceManifest): EvidenceManifest {
  return Object.freeze({
    id: manifest.id,
    scope: cloneScope(manifest.scope),
    mode: manifest.mode,
    status: manifest.status,
    persistence: manifest.persistence,
    derivedMetadata: Object.freeze({ ...manifest.derivedMetadata }),
    pageCount: manifest.pages.length,
    intendedFrameCount: manifest.framePageById.size,
    decodedFrameCount: manifest.decodedFrameCount,
    submittedFrameCount: manifest.submittedFrameCount,
    reviewedFrameCount: manifest.reviewedFrameCount,
  });
}

function coverageSummary(manifest: MutableEvidenceManifest): EvidenceManifestCoverageSummary {
  const intendedFrameCount = manifest.framePageById.size;
  return Object.freeze({
    intendedFrameCount,
    decodedFrameCount: manifest.decodedFrameCount,
    submittedFrameCount: manifest.submittedFrameCount,
    reviewedFrameCount: manifest.reviewedFrameCount,
    exhaustiveInput:
      manifest.mode === 'exhaustive' &&
      manifest.status === 'complete' &&
      intendedFrameCount > 0 &&
      manifest.decodedFrameCount === intendedFrameCount &&
      manifest.submittedFrameCount === intendedFrameCount &&
      manifest.reviewedFrameCount === intendedFrameCount,
    modelComprehensionGuaranteed: false,
  });
}

function assertUserClearRequest(value: unknown): asserts value is UserEvidenceClearRequest {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['projectId', 'intent']))
    throw new RangeError('evidence clear must be project-scoped and require user intent');
  assertOpaqueIdentifier(value.projectId, 'projectId');
  if (value.intent !== 'user-request')
    throw new RangeError('evidence clear requires explicit user intent');
}

function assertProjectHasNoActiveReview(
  manifests: ReadonlyMap<string, MutableEvidenceManifest>,
  projectId: string,
): void {
  assertOpaqueIdentifier(projectId, 'projectId');
  const activeManifestIds = [...manifests.values()]
    .filter(
      (manifest) =>
        manifest.scope.identity.projectId === projectId && manifest.status === 'running',
    )
    .map((manifest) => manifest.id);
  if (activeManifestIds.length > 0)
    throw new EvidenceReviewActiveError(projectId, Object.freeze(activeManifestIds));
}

function assertFrameId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !OPAQUE_FRAME_ID.test(value) || containsUnsafeLocation(value))
    throw new RangeError(`${label} must contain bounded opaque frame identities`);
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

function assertObservationMode(value: unknown): asserts value is ObservationMode {
  if (typeof value !== 'string' || !(OBSERVATION_MODES as readonly string[]).includes(value))
    throw new RangeError('mode must be a supported observation mode');
}

function assertEvidenceCoverageStatus(value: unknown): asserts value is EvidenceCoverageStatus {
  if (typeof value !== 'string' || !(COVERAGE_STATUSES as readonly string[]).includes(value))
    throw new RangeError('status must be a supported evidence coverage status');
}

function assertEvidenceFrameStage(value: unknown): asserts value is EvidenceFrameStage {
  if (value !== 'decoded' && value !== 'submitted' && value !== 'reviewed')
    throw new RangeError('stage must be decoded, submitted, or reviewed');
}

function assertPageIndex(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new RangeError('pageIndex must be a non-negative integer');
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
