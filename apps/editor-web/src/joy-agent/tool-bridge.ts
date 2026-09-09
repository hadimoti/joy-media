import type {
  JoyAgentToolBridge,
  JoyDocumentOperation,
  JoyTimelineOperation,
} from '@joy-media/joy-agent-engine';
import { JOY_CAPTION_TEMPLATES } from '@joy-media/captions-core';
import { TEXT_TEMPLATES } from '../text-template-catalog.js';
import {
  createJoyAgentPagedContext,
  type JoyAgentContextSnapshot,
  type JoyAgentContextSnapshotInput,
  type JoyAgentPagedContext,
} from './context-snapshot.js';
import { isJoyAgentConversationEntityReference } from './conversation-entity-references.js';
import { validateBrowserProposal, type BrowserProposal } from './bounded-tool-loop.js';
import { createLookHostRpcMethods, type PrepareLookHandler } from './look-tool-bridge.js';
import {
  HostRpcDiagnosticError,
  type HostRpcHandlerContext,
  type HostRpcJson,
  type HostRpcMethod,
  type HostRpcMethods,
} from './host-rpc.js';

/** Main-thread bridge: read frozen context and stage proposals without commit access. */
export function createJoyAgentToolBridge(
  snapshot: JoyAgentContextSnapshot,
  onPreview?: (kind: 'timeline' | 'document', count: number) => void,
): JoyAgentToolBridge {
  return {
    readProjectSummary: async () => ({
      projectId: snapshot.projectId,
      revision: snapshot.revision,
      clipCount: snapshot.clips.length,
      assetCount: snapshot.assets.length,
      omitted: snapshot.omitted,
    }),
    readSelection: async () => ({
      selectedClipIds: snapshot.selectedClipIds,
      playheadUs: snapshot.playheadUs,
    }),
    readTimelineWindow: async ({ startUs, endUs }) => ({
      clips: snapshot.clips.filter(
        (clip) => clip.startUs < endUs && clip.startUs + clip.durationUs > startUs,
      ),
    }),
    readAssetMetadata: async ({ assetIds }) => ({
      assets: snapshot.assets.filter((asset) => assetIds.includes(asset.id)),
    }),
    readStyleCatalog: async () => ({ styles: [] }),
    proposeTimelineOperations: async ({
      operations,
    }: {
      readonly operations: readonly JoyTimelineOperation[];
    }) => {
      onPreview?.('timeline', operations.length);
      return { staged: true, operationCount: operations.length, revision: snapshot.revision };
    },
    proposeDocumentOperations: async ({
      operations,
    }: {
      readonly operations: readonly JoyDocumentOperation[];
    }) => {
      onPreview?.('document', operations.length);
      return { staged: true, operationCount: operations.length, revision: snapshot.revision };
    },
    submitPlan: async () => ({ awaitingApproval: true, revision: snapshot.revision }),
  };
}

const HOST_CONTEXT_DOMAINS = [
  'overview',
  'brief',
  'tracks',
  'clips',
  'assets',
  'visual-objects',
  'titles',
  'looks',
] as const;
type HostContextDomain = (typeof HOST_CONTEXT_DOMAINS)[number];
const MAX_HOST_PAGE_SIZE = 32;
const LOOK_INSTANCE_ID_PATTERN = /^look-[A-Za-z0-9][A-Za-z0-9-]{7,64}$/;
const LOOK_DEFINITION_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

export interface JoyAgentPreparedHostResult {
  readonly summary: string;
  readonly baseRevision: string;
  readonly changeSetId: string;
  readonly operationDigest: string;
  readonly bindingDigest: string;
  readonly operationCount: number;
}

/** The host—not the Worker—binds an observation request to one live run epoch. */
export interface JoyAgentObservationToolAuthority {
  readonly projectId: string;
  readonly revision: string;
  readonly run: HostRpcHandlerContext['run'];
}

export interface JoyAgentObservationRange {
  readonly startUs: number;
  readonly endUs: number;
}

export type JoyAgentObservationMode = 'overview' | 'focus' | 'exhaustive';
export type JoyAgentEvidenceStatus = 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';

export interface JoyAgentMediaDescribeRequest {
  readonly assetId: string;
}

export interface JoyAgentMediaObserveRequest {
  readonly assetId: string;
  readonly range: JoyAgentObservationRange;
  readonly mode: JoyAgentObservationMode;
  readonly maxFrames: number;
  /** Bound on adapter-generated JSON metadata, not media bytes. */
  readonly maxMetadataBytes: number;
}

export interface JoyAgentMediaFramesRequest {
  readonly observationId: string;
  readonly cursor: number;
  readonly pageSize: number;
}

export interface JoyAgentMediaTranscriptRequest {
  readonly assetId: string;
  readonly range: JoyAgentObservationRange;
  readonly cursor: number;
  readonly pageSize: number;
}

export interface JoyAgentEvidenceReadRequest {
  readonly manifestId: string;
  readonly pageIndex: number;
}

export interface JoyAgentEvidenceCoverageRequest {
  readonly manifestId: string;
}

/** Metadata-only frame descriptor. Deliberately excludes Blob/bytes/location. */
export interface JoyAgentObservedFrameMetadata {
  readonly id: string;
  readonly actualTimeUs: number;
  readonly durationUs: number;
  readonly presentationIndex: number;
  readonly width: number;
  readonly height: number;
  readonly cacheHit: boolean;
}

/** Transcript timing metadata intentionally excludes transcript word text. */
export interface JoyAgentTranscriptWordMetadata {
  readonly id: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly confidence?: number;
  readonly speakerId?: string;
}

export interface JoyAgentEvidenceCoverageSummary {
  readonly intendedFrameCount: number;
  readonly decodedFrameCount: number;
  readonly submittedFrameCount: number;
  readonly reviewedFrameCount: number;
  readonly exhaustiveInput: boolean;
  readonly modelComprehensionGuaranteed: false;
}

export interface JoyAgentMediaDescribeResult {
  readonly assetId: string;
  readonly assetDigest: string;
  readonly kind: 'image' | 'audio' | 'video';
  readonly durationUs: number;
  readonly streamCount: number;
  readonly transcriptAvailable: boolean;
}

export interface JoyAgentMediaObserveResult {
  readonly observationId: string;
  readonly manifestId: string;
  readonly mode: JoyAgentObservationMode;
  readonly range: JoyAgentObservationRange;
  readonly status: JoyAgentEvidenceStatus;
  readonly intendedFrameCount: number;
  readonly decodedFrameCount: number;
  readonly omittedFrameCount: number;
}

export interface JoyAgentMediaFramesResult {
  readonly observationId: string;
  readonly items: readonly JoyAgentObservedFrameMetadata[];
  readonly nextCursor?: number;
}

export interface JoyAgentMediaTranscriptResult {
  readonly transcriptId: string;
  readonly assetId: string;
  readonly language: string;
  readonly range: JoyAgentObservationRange;
  readonly wordCount: number;
  /**
   * This host-query slice never sends spoken text to a model. A later
   * consent-bound adapter may expose separately sanitized content.
   */
  readonly contentAvailable: false;
  readonly items: readonly JoyAgentTranscriptWordMetadata[];
  readonly nextCursor?: number;
}

export interface JoyAgentEvidenceReadResult {
  readonly manifestId: string;
  readonly pageIndex: number;
  readonly pageCount: number;
  readonly mode: JoyAgentObservationMode;
  readonly status: JoyAgentEvidenceStatus;
  readonly intendedFrameIds: readonly string[];
  readonly decodedFrameIds: readonly string[];
  readonly submittedFrameIds: readonly string[];
  readonly reviewedFrameIds: readonly string[];
  readonly summary: JoyAgentEvidenceCoverageSummary;
}

export interface JoyAgentEvidenceCoverageResult extends JoyAgentEvidenceCoverageSummary {
  readonly manifestId: string;
  readonly mode: JoyAgentObservationMode;
  readonly status: JoyAgentEvidenceStatus;
}

/**
 * Trusted adapter seam for local evidence services. Implementations may use
 * browser workers, caches, manifests, or transcript stores internally, but
 * these methods can return only the metadata contracts declared above.
 */
export interface JoyAgentObservationToolAdapter {
  isAuthorityCurrent(authority: JoyAgentObservationToolAuthority): boolean;
  describe(
    input: JoyAgentMediaDescribeRequest,
    authority: JoyAgentObservationToolAuthority,
    signal: AbortSignal,
  ): JoyAgentMediaDescribeResult | Promise<JoyAgentMediaDescribeResult>;
  observe(
    input: JoyAgentMediaObserveRequest,
    authority: JoyAgentObservationToolAuthority,
    signal: AbortSignal,
  ): JoyAgentMediaObserveResult | Promise<JoyAgentMediaObserveResult>;
  frames(
    input: JoyAgentMediaFramesRequest,
    authority: JoyAgentObservationToolAuthority,
    signal: AbortSignal,
  ): JoyAgentMediaFramesResult | Promise<JoyAgentMediaFramesResult>;
  transcript(
    input: JoyAgentMediaTranscriptRequest,
    authority: JoyAgentObservationToolAuthority,
    signal: AbortSignal,
  ): JoyAgentMediaTranscriptResult | Promise<JoyAgentMediaTranscriptResult>;
  readEvidence(
    input: JoyAgentEvidenceReadRequest,
    authority: JoyAgentObservationToolAuthority,
    signal: AbortSignal,
  ): JoyAgentEvidenceReadResult | Promise<JoyAgentEvidenceReadResult>;
  coverage(
    input: JoyAgentEvidenceCoverageRequest,
    authority: JoyAgentObservationToolAuthority,
    signal: AbortSignal,
  ): JoyAgentEvidenceCoverageResult | Promise<JoyAgentEvidenceCoverageResult>;
}

export interface JoyAgentHostToolBridgeOptions {
  /** Frozen, sanitized project facts retained only on the trusted main thread. */
  readonly context: JoyAgentPagedContext;
  /**
   * The caller must use the canonical compiler and the session-owned prepared
   * change store. It returns display-safe opaque identities only.
   */
  /**
   * Required for every run that advertises `validate_proposal`. A Look-scoped
   * run omits it — `validate_proposal` stays in the method map but is never in
   * that run's allow-list, so the model cannot reach it.
   */
  readonly prepareProposal?: (
    proposal: BrowserProposal,
    context: HostRpcHandlerContext,
  ) => Promise<JoyAgentPreparedHostResult> | JoyAgentPreparedHostResult;
  /**
   * The deterministic Living Look intent handler (R2 / GAP 5). Present only for
   * a Look-scoped run; it resolves + compiles the Look and stages a reversible
   * preview through the same `validate_proposal` staging handler.
   */
  readonly prepareLook?: PrepareLookHandler;
  /** Optional until the trusted host wires a concrete local observation adapter. */
  readonly observation?: JoyAgentObservationToolAdapter;
  /**
   * Private host notification after a bounded source observation completes.
   * It is never serialized through Host RPC and cannot widen the model tool
   * catalog. A caller may use it to mint a short-lived Worker review lease.
   */
  readonly onObservationCompleted?: (
    result: JoyAgentMediaObserveResult,
    authority: JoyAgentObservationToolAuthority,
  ) => void | Promise<void>;
}

function isRecord(value: HostRpcJson): value is { readonly [key: string]: HostRpcJson } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: { readonly [key: string]: HostRpcJson },
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function diagnostic(
  code: 'JOY_AGENT_RPC_INVALID_REQUEST' | 'JOY_AGENT_RPC_CANONICAL_REJECTED',
  options: {
    readonly field?: string;
    readonly operation?: string;
    readonly compilerCode?: string;
    readonly retryable?: boolean;
  } = {},
): HostRpcDiagnosticError {
  return new HostRpcDiagnosticError({
    code,
    retryable: options.retryable ?? true,
    ...(options.operation === undefined ? {} : { operation: options.operation }),
    ...(options.field === undefined ? {} : { field: options.field }),
    ...(options.compilerCode === undefined
      ? {}
      : { facts: { compilerCode: options.compilerCode } }),
  });
}

const OBSERVATION_MODES = ['overview', 'focus', 'exhaustive'] as const;
const EVIDENCE_STATUSES = ['running', 'complete', 'partial', 'failed', 'cancelled'] as const;
const MAX_OBSERVATION_RANGE_US = 6 * 60 * 60 * 1_000_000;
const MAX_OBSERVATION_TIME_US = Number.MAX_SAFE_INTEGER - MAX_OBSERVATION_RANGE_US;
const MAX_OBSERVATION_FRAMES = 512;
const MAX_OBSERVATION_METADATA_BYTES = 32 * 1024;
const MAX_OBSERVATION_PAGE_SIZE = 128;
const MAX_OBSERVATION_CURSOR = 2_097_152;
const MAX_OBSERVATION_DIMENSION = 16_384;
const MAX_EVIDENCE_FRAME_IDS_PER_PAGE = 512;
const SAFE_OPAQUE_IDENTIFIER =
  /^[A-Za-z0-9][A-Za-z0-9._:@=-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:@=-]*)*$/;
const SAFE_LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/;
const SHA_256 = /^[a-f0-9]{64}$/i;
const UNSAFE_HOST_VALUE =
  /(?:\b(?:https?|file|data|blob):|\b[A-Za-z]:|(?:^|\s|=|:|\(|\[)(?:~?\/|\\\\)|(?:^|\/)\.{1,2}(?:\/|$)|\\|\b(?:api[_-]?key|authorization|bearer)\b|\b(?:sk|rk|pk)-[A-Za-z0-9])/i;

function invalidObservationRequest(field: string): never {
  throw diagnostic('JOY_AGENT_RPC_INVALID_REQUEST', { field });
}

function exactKeysWithOptional(
  value: { readonly [key: string]: HostRpcJson },
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length >= required.length &&
    keys.length <= required.length + optional.length &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function readObservationRecord(
  value: HostRpcJson,
  required: readonly string[],
  optional: readonly string[] = [],
  field = 'arguments',
): { readonly [key: string]: HostRpcJson } {
  if (!isRecord(value) || !exactKeysWithOptional(value, required, optional))
    invalidObservationRequest(field);
  return value;
}

function requiredObservationField(
  record: { readonly [key: string]: HostRpcJson },
  key: string,
  field = key,
): HostRpcJson {
  const value = record[key];
  if (value === undefined) invalidObservationRequest(field);
  return value;
}

function isSafeOpaqueIdentifier(value: unknown, maxLength = 128): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    SAFE_OPAQUE_IDENTIFIER.test(value) &&
    !UNSAFE_HOST_VALUE.test(value)
  );
}

function readSafeOpaqueIdentifier(value: unknown, field: string, maxLength = 128): string {
  if (!isSafeOpaqueIdentifier(value, maxLength)) invalidObservationRequest(field);
  return value;
}

function readNonNegativeInteger(
  value: unknown,
  field: string,
  max = MAX_OBSERVATION_CURSOR,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
    invalidObservationRequest(field);
  return value;
}

function readPositiveInteger(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max)
    invalidObservationRequest(field);
  return value;
}

function parseObservationRange(value: HostRpcJson, field = 'range'): JoyAgentObservationRange {
  const record = readObservationRecord(value, ['startUs', 'endUs'], [], field);
  const startUs = readNonNegativeInteger(
    record.startUs,
    `${field}.startUs`,
    MAX_OBSERVATION_TIME_US,
  );
  const endUs = readNonNegativeInteger(record.endUs, `${field}.endUs`, MAX_OBSERVATION_TIME_US);
  if (endUs <= startUs || endUs - startUs > MAX_OBSERVATION_RANGE_US)
    invalidObservationRequest(field);
  return Object.freeze({ startUs, endUs });
}

function parseMediaDescribeArgs(value: HostRpcJson): JoyAgentMediaDescribeRequest {
  const record = readObservationRecord(value, ['assetId']);
  return Object.freeze({ assetId: readSafeOpaqueIdentifier(record.assetId, 'assetId') });
}

function parseMediaObserveArgs(value: HostRpcJson): JoyAgentMediaObserveRequest {
  const record = readObservationRecord(value, [
    'assetId',
    'range',
    'mode',
    'maxFrames',
    'maxMetadataBytes',
  ]);
  if (
    typeof record.mode !== 'string' ||
    !OBSERVATION_MODES.includes(record.mode as JoyAgentObservationMode)
  )
    invalidObservationRequest('mode');
  return Object.freeze({
    assetId: readSafeOpaqueIdentifier(record.assetId, 'assetId'),
    range: parseObservationRange(requiredObservationField(record, 'range')),
    mode: record.mode as JoyAgentObservationMode,
    maxFrames: readPositiveInteger(record.maxFrames, 'maxFrames', MAX_OBSERVATION_FRAMES),
    maxMetadataBytes: readPositiveInteger(
      record.maxMetadataBytes,
      'maxMetadataBytes',
      MAX_OBSERVATION_METADATA_BYTES,
    ),
  });
}

function parseMediaFramesArgs(value: HostRpcJson): JoyAgentMediaFramesRequest {
  const record = readObservationRecord(value, ['observationId', 'cursor', 'pageSize']);
  return Object.freeze({
    observationId: readSafeOpaqueIdentifier(record.observationId, 'observationId'),
    cursor: readNonNegativeInteger(record.cursor, 'cursor'),
    pageSize: readPositiveInteger(record.pageSize, 'pageSize', MAX_OBSERVATION_PAGE_SIZE),
  });
}

function parseMediaTranscriptArgs(value: HostRpcJson): JoyAgentMediaTranscriptRequest {
  const record = readObservationRecord(value, ['assetId', 'range', 'cursor', 'pageSize']);
  return Object.freeze({
    assetId: readSafeOpaqueIdentifier(record.assetId, 'assetId'),
    range: parseObservationRange(requiredObservationField(record, 'range')),
    cursor: readNonNegativeInteger(record.cursor, 'cursor'),
    pageSize: readPositiveInteger(record.pageSize, 'pageSize', MAX_OBSERVATION_PAGE_SIZE),
  });
}

function parseEvidenceReadArgs(value: HostRpcJson): JoyAgentEvidenceReadRequest {
  const record = readObservationRecord(value, ['manifestId', 'pageIndex']);
  return Object.freeze({
    manifestId: readSafeOpaqueIdentifier(record.manifestId, 'manifestId'),
    pageIndex: readNonNegativeInteger(record.pageIndex, 'pageIndex', MAX_OBSERVATION_CURSOR),
  });
}

function parseEvidenceCoverageArgs(value: HostRpcJson): JoyAgentEvidenceCoverageRequest {
  const record = readObservationRecord(value, ['manifestId']);
  return Object.freeze({ manifestId: readSafeOpaqueIdentifier(record.manifestId, 'manifestId') });
}

function readObservationResultRecord(
  value: HostRpcJson,
  required: readonly string[],
  optional: readonly string[] = [],
): { readonly [key: string]: HostRpcJson } {
  if (!isRecord(value) || !exactKeysWithOptional(value, required, optional))
    throw new RangeError('observation result has an invalid schema');
  return value;
}

function requiredObservationResultField(
  record: { readonly [key: string]: HostRpcJson },
  key: string,
): HostRpcJson {
  const value = record[key];
  if (value === undefined) throw new RangeError('observation result is missing a required field');
  return value;
}

function readResultOpaqueIdentifier(value: unknown, maxLength = 128): string {
  if (!isSafeOpaqueIdentifier(value, maxLength))
    throw new RangeError('observation result contains an unsafe identifier');
  return value;
}

function readResultNonNegativeInteger(value: unknown, max = MAX_OBSERVATION_CURSOR): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw new RangeError('observation result contains an invalid count');
  return value;
}

function readResultPositiveInteger(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max)
    throw new RangeError('observation result contains an invalid count');
  return value;
}

function parseObservationResultRange(value: HostRpcJson): JoyAgentObservationRange {
  const record = readObservationResultRecord(value, ['startUs', 'endUs']);
  const startUs = readResultNonNegativeInteger(record.startUs, MAX_OBSERVATION_TIME_US);
  const endUs = readResultNonNegativeInteger(record.endUs, MAX_OBSERVATION_TIME_US);
  if (endUs <= startUs || endUs - startUs > MAX_OBSERVATION_RANGE_US)
    throw new RangeError('observation result contains an invalid range');
  return Object.freeze({ startUs, endUs });
}

function readObservationMode(value: unknown): JoyAgentObservationMode {
  if (typeof value !== 'string' || !OBSERVATION_MODES.includes(value as JoyAgentObservationMode))
    throw new RangeError('observation result contains an invalid mode');
  return value as JoyAgentObservationMode;
}

function readEvidenceStatus(value: unknown): JoyAgentEvidenceStatus {
  if (typeof value !== 'string' || !EVIDENCE_STATUSES.includes(value as JoyAgentEvidenceStatus))
    throw new RangeError('observation result contains an invalid status');
  return value as JoyAgentEvidenceStatus;
}

function parseMediaDescribeResult(value: HostRpcJson): JoyAgentMediaDescribeResult {
  const record = readObservationResultRecord(value, [
    'assetId',
    'assetDigest',
    'kind',
    'durationUs',
    'streamCount',
    'transcriptAvailable',
  ]);
  if (
    typeof record.assetDigest !== 'string' ||
    !SHA_256.test(record.assetDigest) ||
    (record.kind !== 'image' && record.kind !== 'audio' && record.kind !== 'video') ||
    typeof record.transcriptAvailable !== 'boolean'
  )
    throw new RangeError('observation result contains unsafe metadata');
  return Object.freeze({
    assetId: readResultOpaqueIdentifier(record.assetId),
    assetDigest: record.assetDigest.toLowerCase(),
    kind: record.kind,
    durationUs: readResultNonNegativeInteger(record.durationUs, MAX_OBSERVATION_TIME_US),
    streamCount: readResultPositiveInteger(record.streamCount, MAX_OBSERVATION_PAGE_SIZE),
    transcriptAvailable: record.transcriptAvailable,
  });
}

function parseMediaObserveResult(value: HostRpcJson): JoyAgentMediaObserveResult {
  const record = readObservationResultRecord(value, [
    'observationId',
    'manifestId',
    'mode',
    'range',
    'status',
    'intendedFrameCount',
    'decodedFrameCount',
    'omittedFrameCount',
  ]);
  const intendedFrameCount = readResultNonNegativeInteger(record.intendedFrameCount);
  const decodedFrameCount = readResultNonNegativeInteger(record.decodedFrameCount);
  const omittedFrameCount = readResultNonNegativeInteger(record.omittedFrameCount);
  if (decodedFrameCount > intendedFrameCount || omittedFrameCount > intendedFrameCount)
    throw new RangeError('observation result contains inconsistent coverage');
  return Object.freeze({
    observationId: readResultOpaqueIdentifier(record.observationId),
    manifestId: readResultOpaqueIdentifier(record.manifestId),
    mode: readObservationMode(record.mode),
    range: parseObservationResultRange(requiredObservationResultField(record, 'range')),
    status: readEvidenceStatus(record.status),
    intendedFrameCount,
    decodedFrameCount,
    omittedFrameCount,
  });
}

function parseFrameMetadata(value: HostRpcJson): JoyAgentObservedFrameMetadata {
  const record = readObservationResultRecord(value, [
    'id',
    'actualTimeUs',
    'durationUs',
    'presentationIndex',
    'width',
    'height',
    'cacheHit',
  ]);
  if (typeof record.cacheHit !== 'boolean')
    throw new RangeError('observation frame metadata is invalid');
  return Object.freeze({
    id: readResultOpaqueIdentifier(record.id, 512),
    actualTimeUs: readResultNonNegativeInteger(record.actualTimeUs, MAX_OBSERVATION_TIME_US),
    durationUs: readResultPositiveInteger(record.durationUs, MAX_OBSERVATION_TIME_US),
    presentationIndex: readResultNonNegativeInteger(record.presentationIndex),
    width: readResultPositiveInteger(record.width, MAX_OBSERVATION_DIMENSION),
    height: readResultPositiveInteger(record.height, MAX_OBSERVATION_DIMENSION),
    cacheHit: record.cacheHit,
  });
}

function parseMediaFramesResult(value: HostRpcJson): JoyAgentMediaFramesResult {
  const record = readObservationResultRecord(value, ['observationId', 'items'], ['nextCursor']);
  if (!Array.isArray(record.items) || record.items.length > MAX_OBSERVATION_PAGE_SIZE)
    throw new RangeError('observation frame page is invalid');
  const items = Object.freeze(record.items.map((item) => parseFrameMetadata(item)));
  const nextCursor =
    record.nextCursor === undefined ? undefined : readResultNonNegativeInteger(record.nextCursor);
  return Object.freeze({
    observationId: readResultOpaqueIdentifier(record.observationId),
    items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

function parseTranscriptWordMetadata(value: HostRpcJson): JoyAgentTranscriptWordMetadata {
  const record = readObservationResultRecord(
    value,
    ['id', 'startUs', 'endUs'],
    ['confidence', 'speakerId'],
  );
  const startUs = readResultNonNegativeInteger(record.startUs, MAX_OBSERVATION_TIME_US);
  const endUs = readResultNonNegativeInteger(record.endUs, MAX_OBSERVATION_TIME_US);
  if (endUs <= startUs) throw new RangeError('transcript timing metadata is invalid');
  if (
    record.confidence !== undefined &&
    (typeof record.confidence !== 'number' ||
      !Number.isFinite(record.confidence) ||
      record.confidence < 0 ||
      record.confidence > 1)
  )
    throw new RangeError('transcript confidence is invalid');
  const speakerId =
    record.speakerId === undefined ? undefined : readResultOpaqueIdentifier(record.speakerId);
  return Object.freeze({
    id: readResultOpaqueIdentifier(record.id),
    startUs,
    endUs,
    ...(record.confidence === undefined ? {} : { confidence: record.confidence }),
    ...(speakerId === undefined ? {} : { speakerId }),
  });
}

function parseMediaTranscriptResult(value: HostRpcJson): JoyAgentMediaTranscriptResult {
  const record = readObservationResultRecord(
    value,
    ['transcriptId', 'assetId', 'language', 'range', 'wordCount', 'contentAvailable', 'items'],
    ['nextCursor'],
  );
  if (
    typeof record.language !== 'string' ||
    !SAFE_LANGUAGE.test(record.language) ||
    record.contentAvailable !== false ||
    !Array.isArray(record.items) ||
    record.items.length > MAX_OBSERVATION_PAGE_SIZE
  )
    throw new RangeError('transcript metadata is invalid');
  const items = Object.freeze(record.items.map((item) => parseTranscriptWordMetadata(item)));
  const wordCount = readResultNonNegativeInteger(record.wordCount);
  if (items.length > wordCount) throw new RangeError('transcript metadata is inconsistent');
  const nextCursor =
    record.nextCursor === undefined ? undefined : readResultNonNegativeInteger(record.nextCursor);
  return Object.freeze({
    transcriptId: readResultOpaqueIdentifier(record.transcriptId),
    assetId: readResultOpaqueIdentifier(record.assetId),
    language: record.language,
    range: parseObservationResultRange(requiredObservationResultField(record, 'range')),
    wordCount,
    contentAvailable: false,
    items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

function parseFrameIds(value: HostRpcJson): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_FRAME_IDS_PER_PAGE)
    throw new RangeError('evidence result contains an invalid frame page');
  const ids = value.map((item) => readResultOpaqueIdentifier(item, 512));
  if (new Set(ids).size !== ids.length)
    throw new RangeError('evidence result duplicates a frame id');
  return Object.freeze(ids);
}

function parseEvidenceSummary(value: HostRpcJson): JoyAgentEvidenceCoverageSummary {
  const record = readObservationResultRecord(value, [
    'intendedFrameCount',
    'decodedFrameCount',
    'submittedFrameCount',
    'reviewedFrameCount',
    'exhaustiveInput',
    'modelComprehensionGuaranteed',
  ]);
  if (typeof record.exhaustiveInput !== 'boolean' || record.modelComprehensionGuaranteed !== false)
    throw new RangeError('evidence summary is invalid');
  const intendedFrameCount = readResultNonNegativeInteger(record.intendedFrameCount);
  const decodedFrameCount = readResultNonNegativeInteger(record.decodedFrameCount);
  const submittedFrameCount = readResultNonNegativeInteger(record.submittedFrameCount);
  const reviewedFrameCount = readResultNonNegativeInteger(record.reviewedFrameCount);
  if (
    decodedFrameCount > intendedFrameCount ||
    submittedFrameCount > decodedFrameCount ||
    reviewedFrameCount > submittedFrameCount
  )
    throw new RangeError('evidence summary is inconsistent');
  return Object.freeze({
    intendedFrameCount,
    decodedFrameCount,
    submittedFrameCount,
    reviewedFrameCount,
    exhaustiveInput: record.exhaustiveInput,
    modelComprehensionGuaranteed: false,
  });
}

function parseEvidenceReadResult(value: HostRpcJson): JoyAgentEvidenceReadResult {
  const record = readObservationResultRecord(value, [
    'manifestId',
    'pageIndex',
    'pageCount',
    'mode',
    'status',
    'intendedFrameIds',
    'decodedFrameIds',
    'submittedFrameIds',
    'reviewedFrameIds',
    'summary',
  ]);
  const intendedFrameIds = parseFrameIds(
    requiredObservationResultField(record, 'intendedFrameIds'),
  );
  const decodedFrameIds = parseFrameIds(requiredObservationResultField(record, 'decodedFrameIds'));
  const submittedFrameIds = parseFrameIds(
    requiredObservationResultField(record, 'submittedFrameIds'),
  );
  const reviewedFrameIds = parseFrameIds(
    requiredObservationResultField(record, 'reviewedFrameIds'),
  );
  const intended = new Set(intendedFrameIds);
  const submitted = new Set(submittedFrameIds);
  if (
    decodedFrameIds.some((id) => !intended.has(id)) ||
    submittedFrameIds.some((id) => !intended.has(id)) ||
    reviewedFrameIds.some((id) => !submitted.has(id))
  )
    throw new RangeError('evidence result contains an invalid frame relation');
  const pageCount = readResultPositiveInteger(record.pageCount, MAX_OBSERVATION_CURSOR);
  const pageIndex = readResultNonNegativeInteger(record.pageIndex);
  if (pageIndex >= pageCount) throw new RangeError('evidence page is out of range');
  return Object.freeze({
    manifestId: readResultOpaqueIdentifier(record.manifestId),
    pageIndex,
    pageCount,
    mode: readObservationMode(record.mode),
    status: readEvidenceStatus(record.status),
    intendedFrameIds,
    decodedFrameIds,
    submittedFrameIds,
    reviewedFrameIds,
    summary: parseEvidenceSummary(requiredObservationResultField(record, 'summary')),
  });
}

function parseEvidenceCoverageResult(value: HostRpcJson): JoyAgentEvidenceCoverageResult {
  const record = readObservationResultRecord(value, [
    'manifestId',
    'mode',
    'status',
    'intendedFrameCount',
    'decodedFrameCount',
    'submittedFrameCount',
    'reviewedFrameCount',
    'exhaustiveInput',
    'modelComprehensionGuaranteed',
  ]);
  const summary = parseEvidenceSummary({
    intendedFrameCount: requiredObservationResultField(record, 'intendedFrameCount'),
    decodedFrameCount: requiredObservationResultField(record, 'decodedFrameCount'),
    submittedFrameCount: requiredObservationResultField(record, 'submittedFrameCount'),
    reviewedFrameCount: requiredObservationResultField(record, 'reviewedFrameCount'),
    exhaustiveInput: requiredObservationResultField(record, 'exhaustiveInput'),
    modelComprehensionGuaranteed: requiredObservationResultField(
      record,
      'modelComprehensionGuaranteed',
    ),
  });
  return Object.freeze({
    manifestId: readResultOpaqueIdentifier(record.manifestId),
    mode: readObservationMode(record.mode),
    status: readEvidenceStatus(record.status),
    ...summary,
  });
}

function assertMediaObserveResultWithinBudget(
  input: JoyAgentMediaObserveRequest,
  value: HostRpcJson,
): JoyAgentMediaObserveResult {
  const result = parseMediaObserveResult(value);
  const resultBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (
    result.mode !== input.mode ||
    result.range.startUs < input.range.startUs ||
    result.range.endUs > input.range.endUs ||
    result.intendedFrameCount > input.maxFrames ||
    result.decodedFrameCount > input.maxFrames ||
    resultBytes > input.maxMetadataBytes
  )
    throw diagnostic('JOY_AGENT_RPC_CANONICAL_REJECTED', {
      operation: 'media_observe',
      field: 'budget',
      retryable: false,
    });
  return result;
}

function assertMediaFramesResultWithinBudget(
  input: JoyAgentMediaFramesRequest,
  value: HostRpcJson,
): JoyAgentMediaFramesResult {
  const result = parseMediaFramesResult(value);
  if (
    result.items.length > input.pageSize ||
    (result.nextCursor !== undefined && result.nextCursor <= input.cursor)
  )
    throw diagnostic('JOY_AGENT_RPC_CANONICAL_REJECTED', {
      operation: 'media_frames',
      field: 'budget',
      retryable: false,
    });
  return result;
}

function assertMediaTranscriptResultWithinBudget(
  input: JoyAgentMediaTranscriptRequest,
  value: HostRpcJson,
): JoyAgentMediaTranscriptResult {
  const result = parseMediaTranscriptResult(value);
  if (
    result.items.length > input.pageSize ||
    result.range.startUs < input.range.startUs ||
    result.range.endUs > input.range.endUs ||
    result.items.some(
      (item) => item.startUs < input.range.startUs || item.endUs > input.range.endUs,
    ) ||
    (result.nextCursor !== undefined && result.nextCursor <= input.cursor)
  )
    throw diagnostic('JOY_AGENT_RPC_CANONICAL_REJECTED', {
      operation: 'media_transcript',
      field: 'budget',
      retryable: false,
    });
  return result;
}

function assertObservationAuthority(
  adapter: JoyAgentObservationToolAdapter,
  authority: JoyAgentObservationToolAuthority,
  operation: string,
): void {
  let current = false;
  try {
    current = adapter.isAuthorityCurrent(authority);
  } catch {
    current = false;
  }
  if (!current)
    throw diagnostic('JOY_AGENT_RPC_CANONICAL_REJECTED', {
      operation,
      field: 'scope',
      retryable: false,
    });
}

async function executeObservationQuery<Result>(
  adapter: JoyAgentObservationToolAdapter,
  projectId: string,
  revision: string,
  context: HostRpcHandlerContext,
  operation: string,
  invoke: (authority: JoyAgentObservationToolAuthority) => Result | Promise<Result>,
): Promise<Result> {
  const authority: JoyAgentObservationToolAuthority = Object.freeze({
    projectId,
    revision,
    run: Object.freeze({ runId: context.run.runId, epoch: context.run.epoch }),
  });
  try {
    context.signal.throwIfAborted();
    assertObservationAuthority(adapter, authority, operation);
    const result = await invoke(authority);
    context.signal.throwIfAborted();
    assertObservationAuthority(adapter, authority, operation);
    return result;
  } catch (error) {
    if (error instanceof HostRpcDiagnosticError) throw error;
    if (context.signal.aborted)
      throw new HostRpcDiagnosticError({
        code: 'JOY_AGENT_RPC_CANCELLED',
        retryable: false,
        operation,
      });
    throw diagnostic('JOY_AGENT_RPC_CANONICAL_REJECTED', {
      operation,
      field: 'observation',
      retryable: true,
    });
  }
}

function parseContextReadArgs(value: HostRpcJson): {
  readonly domain: HostContextDomain;
  readonly cursor: number;
  readonly pageSize: number;
  readonly query?: string;
} {
  if (!isRecord(value)) throw diagnostic('JOY_AGENT_RPC_INVALID_REQUEST', { field: 'arguments' });
  if (!Object.keys(value).every((key) => ['domain', 'cursor', 'pageSize', 'query'].includes(key)))
    throw diagnostic('JOY_AGENT_RPC_INVALID_REQUEST', { field: 'arguments' });
  const domain = value.domain ?? 'overview';
  const cursor = value.cursor ?? 0;
  const pageSize = value.pageSize ?? MAX_HOST_PAGE_SIZE;
  const query = value.query;
  if (
    typeof domain !== 'string' ||
    !HOST_CONTEXT_DOMAINS.includes(domain as HostContextDomain) ||
    typeof cursor !== 'number' ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    typeof pageSize !== 'number' ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_HOST_PAGE_SIZE ||
    (query !== undefined &&
      (typeof query !== 'string' || query.trim().length === 0 || query.length > 120))
  )
    throw diagnostic('JOY_AGENT_RPC_INVALID_REQUEST', { field: 'arguments' });
  return {
    domain: domain as HostContextDomain,
    cursor,
    pageSize,
    ...(query === undefined ? {} : { query: query.trim().toLowerCase() }),
  };
}

function nextPage<T extends HostRpcJson>(
  records: readonly T[],
  cursor: number,
  pageSize: number,
): { readonly items: readonly T[]; readonly nextCursor?: number } {
  const items = records
    .slice(cursor, cursor + pageSize)
    .map((record) => JSON.parse(JSON.stringify(record)) as T);
  const nextCursor = cursor + items.length;
  return {
    items,
    ...(nextCursor < records.length ? { nextCursor } : {}),
  };
}

function pageForContext(
  context: JoyAgentPagedContext,
  input: ReturnType<typeof parseContextReadArgs>,
): HostRpcJson {
  const revision = context.snapshot.revision;
  if (input.domain === 'overview') {
    if (input.cursor !== 0 || input.query !== undefined)
      throw diagnostic('JOY_AGENT_RPC_INVALID_REQUEST', { field: 'cursor' });
    // The snapshot normally performed this validation already. Repeat it at
    // the actual host-RPC publication boundary so a hand-constructed context
    // cannot smuggle arbitrary project names, text, URLs, or credentials into
    // the Worker response.
    const recentEntityReferences = (context.snapshot.recentEntityReferences ?? [])
      .filter(
        (reference) =>
          isJoyAgentConversationEntityReference(reference) &&
          reference.projectId ===
            (context.snapshot.entityReferenceProjectId ?? context.snapshot.projectId),
      )
      .map((reference) => ({
        version: reference.version,
        projectId: reference.projectId,
        executionId: reference.executionId,
        resultRevision: reference.resultRevision,
        entityId: reference.entityId,
        entityKind: reference.entityKind,
        label: reference.label,
      }));
    return {
      projectId: context.snapshot.projectId,
      revision,
      ...(context.snapshot.compositionId === undefined
        ? {}
        : { compositionId: context.snapshot.compositionId }),
      selectedClipIds: [...context.snapshot.selectedClipIds],
      playheadUs: context.snapshot.playheadUs,
      trackCount: context.trackIds.length,
      clipCount: context.clips.length,
      assetCount: context.assets.length,
      visualObjectCount: context.visualObjects.length,
      // A reopened project's applied Looks are discoverable from `overview`
      // alone: a non-zero count tells a fresh session to page the `looks`
      // domain for the instance ids / pinned pack + version / bindings /
      // overrides it needs, with no prior chat context.
      lookInstanceCount: context.lookInstances.length,
      orphanedLookInstanceCount: context.lookInstances.filter((instance) => instance.orphaned)
        .length,
      creativeBriefAvailable: context.snapshot.creativeBrief !== undefined,
      ...(recentEntityReferences.length === 0 ? {} : { recentEntityReferences }),
      omitted: [...context.omitted],
      catalogs: {
        text: TEXT_TEMPLATES.map((template) => template.id),
        captions: JOY_CAPTION_TEMPLATES.map((template) => template.id),
        transitions: ['dissolve', 'wipe', 'slide'],
      },
    };
  }
  if (input.domain === 'brief') {
    if (input.cursor !== 0 || input.query !== undefined)
      throw diagnostic('JOY_AGENT_RPC_INVALID_REQUEST', { field: 'cursor' });
    if (context.snapshot.creativeBrief === undefined)
      return { projectId: context.snapshot.projectId, revision, available: false };
    return {
      projectId: context.snapshot.projectId,
      revision,
      available: true,
      creativeBrief: JSON.parse(JSON.stringify(context.snapshot.creativeBrief)) as HostRpcJson,
    };
  }
  if (input.domain === 'looks') {
    // Re-assert the opaque-id shape at the publication boundary — the snapshot
    // sanitized these already, but a hand-constructed context must not smuggle
    // an arbitrary token into the Worker response. Optional `query` matches the
    // pack id / instance id / pack title.
    const instances = context.lookInstances.filter(
      (instance) =>
        LOOK_INSTANCE_ID_PATTERN.test(instance.instanceId) &&
        LOOK_DEFINITION_ID_PATTERN.test(instance.definitionId) &&
        (input.query === undefined ||
          instance.definitionId.includes(input.query) ||
          instance.instanceId.toLowerCase().includes(input.query) ||
          (instance.packTitle ?? '').toLowerCase().includes(input.query)),
    );
    const page = nextPage(
      instances as unknown as readonly HostRpcJson[],
      input.cursor,
      input.pageSize,
    );
    return {
      projectId: context.snapshot.projectId,
      revision,
      domain: 'looks',
      ...page,
      ...(context.omitted.length === 0 ? {} : { omitted: [...context.omitted] }),
    };
  }
  const source =
    input.domain === 'tracks'
      ? context.trackIds.map((id) => ({ id }))
      : input.domain === 'clips'
        ? context.clips
        : input.domain === 'assets'
          ? context.assets
          : input.domain === 'visual-objects'
            ? context.visualObjects
            : context.visualObjects.filter(
                (object) =>
                  object.text !== undefined &&
                  (input.query === undefined || object.text.toLowerCase().includes(input.query)),
              );
  const page = nextPage(source as readonly HostRpcJson[], input.cursor, input.pageSize);
  return {
    projectId: context.snapshot.projectId,
    revision,
    domain: input.domain,
    ...page,
    ...(context.omitted.length === 0 ? {} : { omitted: [...context.omitted] }),
  };
}

function parseContextPageResult(value: HostRpcJson): HostRpcJson {
  if (
    !isRecord(value) ||
    typeof value.projectId !== 'string' ||
    typeof value.revision !== 'string' ||
    (value.domain !== undefined && typeof value.domain !== 'string')
  )
    throw diagnostic('JOY_AGENT_RPC_INVALID_REQUEST', { field: 'result' });
  return value;
}

function parsePreparedHostResult(value: HostRpcJson): JoyAgentPreparedHostResult {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'summary',
      'baseRevision',
      'changeSetId',
      'operationDigest',
      'bindingDigest',
      'operationCount',
    ])
  )
    throw diagnostic('JOY_AGENT_RPC_INVALID_REQUEST', { field: 'result' });
  if (
    typeof value.summary !== 'string' ||
    value.summary.length > 512 ||
    typeof value.baseRevision !== 'string' ||
    value.baseRevision.length > 256 ||
    typeof value.changeSetId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value.changeSetId) ||
    typeof value.operationDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.operationDigest) ||
    typeof value.bindingDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.bindingDigest) ||
    typeof value.operationCount !== 'number' ||
    !Number.isSafeInteger(value.operationCount) ||
    value.operationCount <= 0 ||
    value.operationCount > 32
  )
    throw diagnostic('JOY_AGENT_RPC_INVALID_REQUEST', { field: 'result' });
  return {
    summary: value.summary,
    baseRevision: value.baseRevision,
    changeSetId: value.changeSetId,
    operationDigest: value.operationDigest,
    bindingDigest: value.bindingDigest,
    operationCount: value.operationCount,
  };
}

/**
 * Build the production host method map. The Worker sees only the returned
 * JSON pages and prepared identities; the full frozen project and canonical
 * compiler remain in this main-thread closure.
 */
export function createJoyAgentHostRpcMethods(
  options: JoyAgentHostToolBridgeOptions,
): HostRpcMethods {
  const readProjectContext: HostRpcMethod<ReturnType<typeof parseContextReadArgs>, HostRpcJson> = {
    parseArgs: parseContextReadArgs,
    execute: async (input, context) => {
      context.signal.throwIfAborted();
      return pageForContext(options.context, input);
    },
    parseResult: parseContextPageResult,
  };
  const validateProposal: HostRpcMethod<BrowserProposal, JoyAgentPreparedHostResult> = {
    parseArgs: (value) => {
      try {
        return validateBrowserProposal(value);
      } catch {
        throw diagnostic('JOY_AGENT_RPC_CANONICAL_REJECTED', {
          field: 'operations',
          compilerCode: 'JOY_AGENT_INVALID_PROPOSAL',
        });
      }
    },
    execute: async (proposal, context) => {
      context.signal.throwIfAborted();
      if (options.prepareProposal === undefined)
        throw diagnostic('JOY_AGENT_RPC_CANONICAL_REJECTED', {
          field: 'operations',
          compilerCode: 'JOY_AGENT_VALIDATE_PROPOSAL_UNAVAILABLE',
          retryable: false,
        });
      try {
        return await options.prepareProposal(proposal, context);
      } catch (error) {
        if (error instanceof HostRpcDiagnosticError) throw error;
        const compilerCode =
          error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
            ? error.message
            : 'JOY_AGENT_CANONICAL_COMPILER_REJECTED';
        throw diagnostic('JOY_AGENT_RPC_CANONICAL_REJECTED', {
          field: 'operations',
          compilerCode,
        });
      }
    },
    parseResult: parsePreparedHostResult,
  };
  const baseMethods = {
    read_project_context: readProjectContext as HostRpcMethod<unknown, unknown>,
    validate_proposal: validateProposal as HostRpcMethod<unknown, unknown>,
    ...(options.prepareLook === undefined ? {} : createLookHostRpcMethods(options.prepareLook)),
  } as const;
  const observation = options.observation;
  if (observation === undefined) return baseMethods as HostRpcMethods;

  const projectId = options.context.snapshot.projectId;
  const revision = options.context.snapshot.revision;
  const mediaDescribe: HostRpcMethod<JoyAgentMediaDescribeRequest, JoyAgentMediaDescribeResult> = {
    parseArgs: parseMediaDescribeArgs,
    execute: (input, context) =>
      executeObservationQuery(
        observation,
        projectId,
        revision,
        context,
        'media_describe',
        (authority) => observation.describe(input, authority, context.signal),
      ),
    parseResult: parseMediaDescribeResult,
  };
  const mediaObserve: HostRpcMethod<JoyAgentMediaObserveRequest, JoyAgentMediaObserveResult> = {
    parseArgs: parseMediaObserveArgs,
    execute: (input, context) =>
      executeObservationQuery(
        observation,
        projectId,
        revision,
        context,
        'media_observe',
        async (authority) => {
          const result = assertMediaObserveResultWithinBudget(
            input,
            (await observation.observe(input, authority, context.signal)) as unknown as HostRpcJson,
          );
          context.signal.throwIfAborted();
          // A callback fault must not turn a successful local observation into
          // a new model-visible capability. The bounded tool result remains
          // unchanged; a future consent affordance simply stays unavailable.
          try {
            await options.onObservationCompleted?.(result, authority);
          } catch {
            // Private review registration is best effort and fail-closed.
          }
          return result;
        },
      ),
    parseResult: parseMediaObserveResult,
  };
  const mediaFrames: HostRpcMethod<JoyAgentMediaFramesRequest, JoyAgentMediaFramesResult> = {
    parseArgs: parseMediaFramesArgs,
    execute: (input, context) =>
      executeObservationQuery(
        observation,
        projectId,
        revision,
        context,
        'media_frames',
        async (authority) =>
          assertMediaFramesResultWithinBudget(
            input,
            (await observation.frames(input, authority, context.signal)) as unknown as HostRpcJson,
          ),
      ),
    parseResult: parseMediaFramesResult,
  };
  const mediaTranscript: HostRpcMethod<
    JoyAgentMediaTranscriptRequest,
    JoyAgentMediaTranscriptResult
  > = {
    parseArgs: parseMediaTranscriptArgs,
    execute: (input, context) =>
      executeObservationQuery(
        observation,
        projectId,
        revision,
        context,
        'media_transcript',
        async (authority) =>
          assertMediaTranscriptResultWithinBudget(
            input,
            (await observation.transcript(
              input,
              authority,
              context.signal,
            )) as unknown as HostRpcJson,
          ),
      ),
    parseResult: parseMediaTranscriptResult,
  };
  const evidenceRead: HostRpcMethod<JoyAgentEvidenceReadRequest, JoyAgentEvidenceReadResult> = {
    parseArgs: parseEvidenceReadArgs,
    execute: (input, context) =>
      executeObservationQuery(
        observation,
        projectId,
        revision,
        context,
        'evidence_read',
        (authority) => observation.readEvidence(input, authority, context.signal),
      ),
    parseResult: parseEvidenceReadResult,
  };
  const evidenceCoverage: HostRpcMethod<
    JoyAgentEvidenceCoverageRequest,
    JoyAgentEvidenceCoverageResult
  > = {
    parseArgs: parseEvidenceCoverageArgs,
    execute: (input, context) =>
      executeObservationQuery(
        observation,
        projectId,
        revision,
        context,
        'evidence_coverage',
        (authority) => observation.coverage(input, authority, context.signal),
      ),
    parseResult: parseEvidenceCoverageResult,
  };
  return {
    ...baseMethods,
    media_describe: mediaDescribe as HostRpcMethod<unknown, unknown>,
    media_observe: mediaObserve as HostRpcMethod<unknown, unknown>,
    media_frames: mediaFrames as HostRpcMethod<unknown, unknown>,
    media_transcript: mediaTranscript as HostRpcMethod<unknown, unknown>,
    evidence_read: evidenceRead as HostRpcMethod<unknown, unknown>,
    evidence_coverage: evidenceCoverage as HostRpcMethod<unknown, unknown>,
  } as HostRpcMethods;
}

/** Convenience constructor keeps all page data frozen before the RPC host mounts. */
export function createJoyAgentHostRpcMethodsForSnapshot(
  input: JoyAgentContextSnapshotInput,
  prepareProposal: JoyAgentHostToolBridgeOptions['prepareProposal'],
  observation?: JoyAgentObservationToolAdapter,
  onObservationCompleted?: JoyAgentHostToolBridgeOptions['onObservationCompleted'],
): HostRpcMethods {
  return createJoyAgentHostRpcMethods({
    context: createJoyAgentPagedContext(input),
    ...(prepareProposal === undefined ? {} : { prepareProposal }),
    ...(observation === undefined ? {} : { observation }),
    ...(onObservationCompleted === undefined ? {} : { onObservationCompleted }),
  });
}
