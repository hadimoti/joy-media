import { assertFrameIdentity, frameIdentityKey } from '@joy-media/media-core';
import type { EvidenceCoverageStatus } from '@joy-media/media-core';
import type {
  ProjectMediaObservationSource,
  ProjectMediaResolver,
} from '../project-media-resolver.js';
import type {
  ObservationCache,
  ObservationCacheIdentity,
} from '../media-observation/observation-cache.js';
import {
  createObservationService,
  ObservationServiceError,
  type ObservationRunAuthority,
  type ObservationServiceOptions,
  type ObservationSourceVariant,
} from '../media-observation/observation-service.js';
import type {
  EvidenceManifestLookup,
  EvidenceManifestScope,
  EvidenceStore,
  ObservationEvidenceIdentity,
} from '../media-observation/evidence-store.js';
import type { ObservationWorkerClient } from '../media-observation/observation-worker-client.js';
import type { ObservationWorkerDecodedFrame } from '../media-observation/observation-protocol.js';
import type { SourceObservationRange } from '../media-observation/source-decoder.js';
import {
  createObservationTransferEvidenceResolver,
  type ObservationPayloadRecord,
} from './observation-payload-resolver.js';
import type {
  ObservationTransferAuthority,
  ObservationTransferEvidenceResolver,
} from './observation-transfer-service.js';
import type {
  JoyAgentEvidenceCoverageRequest,
  JoyAgentEvidenceReadRequest,
  JoyAgentMediaDescribeRequest,
  JoyAgentMediaFramesRequest,
  JoyAgentMediaObserveRequest,
  JoyAgentMediaObserveResult,
  JoyAgentMediaTranscriptRequest,
  JoyAgentObservationRange,
  JoyAgentObservationToolAdapter,
  JoyAgentObservationToolAuthority,
  JoyAgentObservedFrameMetadata,
  JoyAgentTranscriptWordMetadata,
} from './tool-bridge.js';

const MAX_RANGE_US = 6 * 60 * 60 * 1_000_000;
const MAX_TOOL_TIME_US = Number.MAX_SAFE_INTEGER - MAX_RANGE_US;
const MAX_TOOL_FRAMES = 512;
const MAX_TOOL_PAGE_SIZE = 128;
const MAX_TOOL_CURSOR = 2_097_152;
const MAX_TOOL_DIMENSION = 16_384;
const MAX_TOOL_METADATA_BYTES = 32 * 1024;
const MAX_THUMBNAIL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_REVISION_IDENTIFIER_LENGTH = 256;
const MAX_FRAME_IDENTIFIER_LENGTH = 512;
const MAX_TRANSCRIPT_ITEMS = 4_096;
const SHA_256 = /^[a-f0-9]{64}$/i;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@=-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:@=-]*)*$/;
const UNSAFE_LOCATION = /(?:\b(?:https?|file|data|blob):|\b[A-Za-z]:|(?:^|\/)\.{1,2}(?:\/|$)|\\)/i;
const OBSERVATION_MODES = ['overview', 'focus', 'exhaustive'] as const;

export interface JoyAgentObservationCurrentAuthority {
  readonly projectId: string;
  readonly revision: string;
  readonly run: JoyAgentObservationToolAuthority['run'];
  /** Provider/model identifier is host-only evidence scope, never a secret. */
  readonly modelId: string;
  /** Binds derived evidence to the active prompt/policy contract. */
  readonly promptPolicyDigest: string;
}

/** Timing-only transcript metadata. Spoken text is intentionally not accepted here. */
export interface JoyAgentTranscriptTimingMetadata {
  readonly id: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly confidence?: number;
  readonly speakerId?: string;
}

/**
 * Trusted asset facts supplied by the host project model. The adapter never
 * probes a Blob for duration, digest, stream identity, or transcript content.
 */
export interface JoyAgentObservationAssetMetadata {
  readonly assetId: string;
  readonly assetDigest: string;
  readonly kind: 'image' | 'audio' | 'video';
  readonly durationUs: number;
  readonly streamCount: number;
  /** Required only for source-video observation. */
  readonly streamId?: string;
  /** Required only for source-video observation. */
  readonly sourceVariant?: ObservationSourceVariant;
  readonly transcript?: {
    readonly transcriptId: string;
    readonly language: string;
    readonly items: readonly JoyAgentTranscriptTimingMetadata[];
  };
}

export interface CreateJoyAgentObservationToolAdapterOptions {
  readonly projectId: string;
  /** Trusted host resolver: it supplies a local Blob, never a URL/path to the agent. */
  readonly resolver: Pick<ProjectMediaResolver, 'resolveObservationSource'>;
  readonly worker: Pick<ObservationWorkerClient, 'frames'>;
  readonly evidenceStore: EvidenceStore;
  readonly cache: ObservationCache;
  /** Immutable project metadata lookup; it must not inspect model input. */
  readonly assetLookup: (
    assetId: string,
  ) =>
    | JoyAgentObservationAssetMetadata
    | undefined
    | Promise<JoyAgentObservationAssetMetadata | undefined>;
  /** Reads the current host run/model/policy binding at every trusted boundary. */
  readonly currentAuthority: () => JoyAgentObservationCurrentAuthority | undefined;
  /** Aggregate decoded-thumbnail byte budget for one observation. */
  readonly maxThumbnailBytes?: number;
  /** Test-only hook; production uses the ObservationService Web Crypto digest. */
  readonly digestThumbnail?: ObservationServiceOptions['digestThumbnail'];
}

/**
 * Host-only companion to the metadata-only Worker tool adapter. The resolver
 * factory is intentionally separate from `tools`, so HostRpc cannot discover
 * cache bytes, source locations, or a path to direct provider transfer.
 */
export interface JoyAgentObservationHostBridge {
  readonly tools: JoyAgentObservationToolAdapter;
  createEvidenceResolver(manifest: EvidenceManifestLookup): ObservationTransferEvidenceResolver;
  /**
   * Produces a private, bounded image-review candidate for one completed
   * source observation. It is intentionally absent from `tools`, so a model
   * can neither enumerate it nor obtain a resolver/byte capability.
   */
  createReviewCandidate(observationId: string): JoyAgentObservationReviewCandidate | undefined;
  /**
   * Records evidence stages only after the Worker returns a verified success.
   * This is a local accounting operation; it never returns media or provider
   * details and it refuses stale/foreign manifests.
   */
  markReviewedEvidence(input: JoyAgentObservationReviewCandidate): boolean;
}

export interface JoyAgentObservationReviewCandidate {
  readonly authority: ObservationTransferAuthority;
  readonly manifest: EvidenceManifestLookup;
  readonly range: {
    readonly domain: 'source';
    readonly startUs: number;
    readonly endUs: number;
  };
  readonly evidenceIds: readonly string[];
}

export type JoyAgentObservationToolAdapterErrorCode =
  | 'cancelled'
  | 'stale-authority'
  | 'invalid-request'
  | 'asset-unavailable'
  | 'unsupported-media'
  | 'source-unavailable'
  | 'manifest-unavailable'
  | 'observation-failed';

/** Redacted host error. Raw source/worker/provider details never cross the tool seam. */
export class JoyAgentObservationToolAdapterError extends Error {
  constructor(readonly code: JoyAgentObservationToolAdapterErrorCode) {
    super(`JOY observation adapter failed: ${code}`);
    this.name = 'JoyAgentObservationToolAdapterError';
  }
}

interface NormalizedOptions {
  readonly projectId: string;
  readonly resolver: Pick<ProjectMediaResolver, 'resolveObservationSource'>;
  readonly worker: Pick<ObservationWorkerClient, 'frames'>;
  readonly evidenceStore: EvidenceStore;
  readonly cache: ObservationCache;
  readonly assetLookup: CreateJoyAgentObservationToolAdapterOptions['assetLookup'];
  readonly currentAuthority: CreateJoyAgentObservationToolAdapterOptions['currentAuthority'];
  readonly maxThumbnailBytes: number;
  readonly digestThumbnail: ObservationServiceOptions['digestThumbnail'];
}

interface NormalizedTranscript {
  readonly transcriptId: string;
  readonly language: string;
  readonly items: readonly JoyAgentTranscriptWordMetadata[];
}

interface NormalizedAssetMetadata {
  readonly assetId: string;
  readonly assetDigest: string;
  readonly kind: 'image' | 'audio' | 'video';
  readonly durationUs: number;
  readonly streamCount: number;
  readonly streamId?: string;
  readonly sourceVariant?: ObservationSourceVariant;
  readonly transcript?: NormalizedTranscript;
}

interface ObservationRecord {
  readonly observationId: string;
  readonly manifestId: string;
  readonly lookup: EvidenceManifestLookup;
  readonly authority: JoyAgentObservationCurrentAuthority;
  readonly assetId: string;
  readonly range: JoyAgentObservationRange;
  readonly mode: JoyAgentMediaObserveRequest['mode'];
  readonly frames: JoyAgentObservedFrameMetadata[];
  readonly cacheIdentity: ObservationCacheIdentity;
  /** Local decoder MIME facts only; the generic model tools never receive them. */
  readonly frameMimeTypes: Map<string, 'image/jpeg' | 'image/png'>;
  readonly framePageById: ReadonlyMap<string, number>;
}

interface FramePlan {
  readonly frameIds: readonly string[];
  readonly limited: boolean;
}

/**
 * Main-thread-only adapter for the bounded observation tools. It intentionally
 * performs a small, bounded local preflight before creating an evidence
 * manifest: EvidenceStore requires real intended frame identities before it
 * can checkpoint decode results. The preflight derives those identities from
 * the trusted Worker; it never manufactures source-frame identifiers.
 *
 * This means source observation is currently decoded twice (identity preflight
 * then cache/checkpoint decode). That is a truthful bounded fallback until a
 * worker-side canonical frame index can create the manifest in one pass.
 */
export function createJoyAgentObservationToolAdapter(
  rawOptions: CreateJoyAgentObservationToolAdapterOptions,
): JoyAgentObservationToolAdapter {
  return createJoyAgentObservationHostBridge(rawOptions).tools;
}

/**
 * Creates the private main-thread bridge used by the explicit consent flow.
 * `tools` remains safe to bind into HostRpc; `createEvidenceResolver` is only
 * for the UI host that owns the opaque consent and direct BYOK transport.
 */
export function createJoyAgentObservationHostBridge(
  rawOptions: CreateJoyAgentObservationToolAdapterOptions,
): JoyAgentObservationHostBridge {
  const options = normalizeOptions(rawOptions);
  const recordsByObservationId = new Map<string, ObservationRecord>();
  const recordsByManifestId = new Map<string, ObservationRecord>();
  let nextSequence = 0;
  const service = createObservationService({
    projectId: options.projectId,
    resolver: options.resolver,
    worker: options.worker,
    evidenceStore: options.evidenceStore,
    cache: options.cache,
    isAuthorityCurrent: (candidate) => isObservationRunAuthorityCurrent(candidate, options),
    ...(options.digestThumbnail === undefined ? {} : { digestThumbnail: options.digestThumbnail }),
  });

  const requireAsset = async (
    assetId: string,
    authority: JoyAgentObservationToolAuthority,
    signal: AbortSignal,
  ): Promise<{
    readonly asset: NormalizedAssetMetadata;
    readonly current: JoyAgentObservationCurrentAuthority;
  }> => {
    throwIfAborted(signal);
    const before = requireCurrentAuthority(authority, options);
    let rawAsset: JoyAgentObservationAssetMetadata | undefined;
    try {
      rawAsset = await options.assetLookup(assetId);
    } catch {
      throw new JoyAgentObservationToolAdapterError('asset-unavailable');
    }
    throwIfAborted(signal);
    const after = requireCurrentAuthority(authority, options);
    if (!sameAuthority(before, after))
      throw new JoyAgentObservationToolAdapterError('stale-authority');
    if (rawAsset === undefined) throw new JoyAgentObservationToolAdapterError('asset-unavailable');
    try {
      return Object.freeze({ asset: normalizeAssetMetadata(rawAsset, assetId), current: after });
    } catch (error) {
      if (
        error instanceof JoyAgentObservationToolAdapterError &&
        error.code === 'asset-unavailable'
      )
        throw error;
      throw new JoyAgentObservationToolAdapterError('asset-unavailable');
    }
  };

  const assertRecordAuthority = (
    record: ObservationRecord,
    authority: JoyAgentObservationToolAuthority,
  ): void => {
    const current = requireCurrentAuthority(authority, options);
    if (!sameAuthority(record.authority, current)) {
      throw new JoyAgentObservationToolAdapterError('stale-authority');
    }
  };

  const createRecord = (
    asset: NormalizedAssetMetadata,
    current: JoyAgentObservationCurrentAuthority,
    request: JoyAgentMediaObserveRequest,
    framePlan: FramePlan,
  ): ObservationRecord => {
    const identity: ObservationEvidenceIdentity = Object.freeze({
      projectId: current.projectId,
      assetDigest: asset.assetDigest,
      projectRevision: current.revision,
      modelId: current.modelId,
      promptPolicyDigest: current.promptPolicyDigest,
    });
    const scope: EvidenceManifestScope = Object.freeze({ runId: current.run.runId, identity });
    const manifestId = nextManifestId(current, () => {
      nextSequence += 1;
      return nextSequence;
    });
    const lookup: EvidenceManifestLookup = Object.freeze({ manifestId, scope });
    const cacheIdentity = cacheIdentityFor(asset, current);
    try {
      options.evidenceStore.createManifest({
        id: manifestId,
        scope,
        mode: request.mode,
        intendedFrameIdPages: pageFrameIds(framePlan.frameIds),
        persistence: 'ephemeral',
      });
    } catch {
      throw new JoyAgentObservationToolAdapterError('manifest-unavailable');
    }
    const record: ObservationRecord = {
      observationId: manifestId,
      manifestId,
      lookup,
      authority: cloneAuthority(current),
      assetId: asset.assetId,
      range: Object.freeze({ startUs: request.range.startUs, endUs: request.range.endUs }),
      mode: request.mode,
      frames: [],
      cacheIdentity,
      frameMimeTypes: new Map<string, 'image/jpeg' | 'image/png'>(),
      framePageById: framePageIndex(framePlan.frameIds),
    };
    recordsByObservationId.set(record.observationId, record);
    recordsByManifestId.set(record.manifestId, record);
    return record;
  };

  const setTerminalStatus = (record: ObservationRecord, status: EvidenceCoverageStatus): void => {
    try {
      if (!options.evidenceStore.setStatus({ ...record.lookup, status }))
        throw new JoyAgentObservationToolAdapterError('manifest-unavailable');
    } catch (error) {
      if (error instanceof JoyAgentObservationToolAdapterError) throw error;
      throw new JoyAgentObservationToolAdapterError('manifest-unavailable');
    }
  };

  const resultForRecord = (record: ObservationRecord): JoyAgentMediaObserveResult => {
    const manifest = options.evidenceStore.readManifest(record.lookup);
    if (manifest === undefined)
      throw new JoyAgentObservationToolAdapterError('manifest-unavailable');
    return Object.freeze({
      observationId: record.observationId,
      manifestId: record.manifestId,
      mode: record.mode,
      range: record.range,
      status: manifest.status,
      intendedFrameCount: manifest.intendedFrameCount,
      decodedFrameCount: manifest.decodedFrameCount,
      // This is the known omission inside the concrete manifest. A partial
      // status, rather than an invented total, conveys a bounded preflight
      // discovered more source frames than this run can safely retain.
      omittedFrameCount: manifest.intendedFrameCount - manifest.decodedFrameCount,
    });
  };

  const tools: JoyAgentObservationToolAdapter = {
    isAuthorityCurrent(authority) {
      try {
        requireCurrentAuthority(authority, options);
        return true;
      } catch {
        return false;
      }
    },

    async describe(input, authority, signal) {
      assertDescribeRequest(input);
      const { asset } = await requireAsset(input.assetId, authority, signal);
      throwIfAborted(signal);
      return Object.freeze({
        assetId: asset.assetId,
        assetDigest: asset.assetDigest,
        kind: asset.kind,
        durationUs: asset.durationUs,
        streamCount: asset.streamCount,
        transcriptAvailable: asset.transcript !== undefined,
      });
    },

    async observe(input, authority, signal) {
      assertObserveRequest(input);
      const { asset, current } = await requireAsset(input.assetId, authority, signal);
      assertRangeWithinAsset(input.range, asset.durationUs);
      if (
        asset.kind !== 'video' ||
        asset.streamId === undefined ||
        asset.sourceVariant === undefined
      )
        throw new JoyAgentObservationToolAdapterError('unsupported-media');

      const plan = await preflightFramePlan({
        options,
        asset,
        authority: current,
        range: input.range,
        maxFrames: input.maxFrames,
        signal,
      });
      throwIfAborted(signal);
      const currentAfterPlan = requireCurrentAuthority(authority, options);
      if (!sameAuthority(current, currentAfterPlan))
        throw new JoyAgentObservationToolAdapterError('stale-authority');

      const record = createRecord(asset, currentAfterPlan, input, plan);
      if (plan.frameIds.length === 0) {
        setTerminalStatus(record, plan.limited ? 'partial' : 'complete');
        return resultForRecord(record);
      }

      const serviceAuthority: ObservationRunAuthority = Object.freeze({
        projectId: currentAfterPlan.projectId,
        run: Object.freeze({ ...currentAfterPlan.run }),
        assetId: asset.assetId,
        assetDigest: asset.assetDigest,
        streamId: asset.streamId,
        projectRevision: currentAfterPlan.revision,
        modelId: currentAfterPlan.modelId,
        promptPolicyDigest: currentAfterPlan.promptPolicyDigest,
        manifestId: record.manifestId,
        range: Object.freeze({ ...input.range }),
        sourceVariant: asset.sourceVariant,
        maxFrames: plan.frameIds.length,
        maxThumbnailBytes: options.maxThumbnailBytes,
      });
      const planned = new Set(plan.frameIds);
      try {
        for await (const frame of service.observe(serviceAuthority, signal)) {
          throwIfAborted(signal);
          assertRecordAuthority(record, authority);
          if (!planned.has(frame.id) || record.frames.some((item) => item.id === frame.id))
            throw new JoyAgentObservationToolAdapterError('observation-failed');
          record.frames.push(
            Object.freeze({
              id: frame.id,
              actualTimeUs: frame.actualTimeUs,
              durationUs: frame.durationUs,
              presentationIndex: frame.presentationIndex,
              width: frame.width,
              height: frame.height,
              cacheHit: frame.cacheHit,
            }),
          );
          record.frameMimeTypes.set(frame.id, frame.thumbnailMimeType);
        }
        if (record.frames.length !== plan.frameIds.length)
          throw new JoyAgentObservationToolAdapterError('observation-failed');
        setTerminalStatus(record, plan.limited ? 'partial' : 'complete');
      } catch (error) {
        const expectedBoundedStop =
          error instanceof ObservationServiceError &&
          error.code === 'budget-exceeded' &&
          plan.limited &&
          record.frames.length === plan.frameIds.length;
        if (expectedBoundedStop) {
          setTerminalStatus(record, 'partial');
          return resultForRecord(record);
        }
        const status = terminalStatusForError(error, signal);
        setTerminalStatus(record, status);
        throw normalizeObservationError(error, signal);
      }
      return resultForRecord(record);
    },

    async frames(input, authority, signal) {
      assertFramesRequest(input);
      throwIfAborted(signal);
      const record = recordsByObservationId.get(input.observationId);
      if (record === undefined)
        throw new JoyAgentObservationToolAdapterError('manifest-unavailable');
      assertRecordAuthority(record, authority);
      const items = record.frames.slice(input.cursor, input.cursor + input.pageSize);
      throwIfAborted(signal);
      assertRecordAuthority(record, authority);
      const nextCursor = input.cursor + items.length;
      return Object.freeze({
        observationId: record.observationId,
        items: Object.freeze(items.map((item) => Object.freeze({ ...item }))),
        ...(nextCursor < record.frames.length ? { nextCursor } : {}),
      });
    },

    async transcript(input, authority, signal) {
      assertTranscriptRequest(input);
      const { asset } = await requireAsset(input.assetId, authority, signal);
      assertRangeWithinAsset(input.range, asset.durationUs);
      const transcript = asset.transcript;
      const allItems =
        transcript === undefined
          ? []
          : transcript.items.filter(
              (item) => item.startUs >= input.range.startUs && item.endUs <= input.range.endUs,
            );
      const items = allItems.slice(input.cursor, input.cursor + input.pageSize);
      throwIfAborted(signal);
      requireCurrentAuthority(authority, options);
      const nextCursor = input.cursor + items.length;
      return Object.freeze({
        transcriptId: transcript?.transcriptId ?? fallbackTranscriptId(asset.assetId),
        assetId: asset.assetId,
        language: transcript?.language ?? 'und',
        range: Object.freeze({ ...input.range }),
        wordCount: allItems.length,
        contentAvailable: false,
        items: Object.freeze(items.map((item) => Object.freeze({ ...item }))),
        ...(nextCursor < allItems.length ? { nextCursor } : {}),
      });
    },

    async readEvidence(input, authority, signal) {
      assertEvidenceReadRequest(input);
      throwIfAborted(signal);
      const record = recordsByManifestId.get(input.manifestId);
      if (record === undefined)
        throw new JoyAgentObservationToolAdapterError('manifest-unavailable');
      assertRecordAuthority(record, authority);
      const page = options.evidenceStore.readCoveragePage({
        ...record.lookup,
        pageIndex: input.pageIndex,
      });
      if (page === undefined) throw new JoyAgentObservationToolAdapterError('manifest-unavailable');
      throwIfAborted(signal);
      assertRecordAuthority(record, authority);
      return Object.freeze({
        manifestId: record.manifestId,
        pageIndex: page.pageIndex,
        pageCount: page.pageCount,
        mode: asToolObservationMode(page.mode),
        status: page.status,
        intendedFrameIds: Object.freeze([...page.intendedFrameIds]),
        decodedFrameIds: Object.freeze([...page.decodedFrameIds]),
        submittedFrameIds: Object.freeze([...page.submittedFrameIds]),
        reviewedFrameIds: Object.freeze([...page.reviewedFrameIds]),
        summary: Object.freeze({ ...page.summary, modelComprehensionGuaranteed: false as const }),
      });
    },

    async coverage(input, authority, signal) {
      assertEvidenceCoverageRequest(input);
      throwIfAborted(signal);
      const record = recordsByManifestId.get(input.manifestId);
      if (record === undefined)
        throw new JoyAgentObservationToolAdapterError('manifest-unavailable');
      assertRecordAuthority(record, authority);
      const manifest = options.evidenceStore.readManifest(record.lookup);
      if (manifest === undefined)
        throw new JoyAgentObservationToolAdapterError('manifest-unavailable');
      throwIfAborted(signal);
      assertRecordAuthority(record, authority);
      return Object.freeze({
        manifestId: record.manifestId,
        mode: asToolObservationMode(manifest.mode),
        status: manifest.status,
        intendedFrameCount: manifest.intendedFrameCount,
        decodedFrameCount: manifest.decodedFrameCount,
        submittedFrameCount: manifest.submittedFrameCount,
        reviewedFrameCount: manifest.reviewedFrameCount,
        exhaustiveInput:
          manifest.mode === 'exhaustive' &&
          manifest.status === 'complete' &&
          manifest.intendedFrameCount > 0 &&
          manifest.decodedFrameCount === manifest.intendedFrameCount &&
          manifest.submittedFrameCount === manifest.intendedFrameCount &&
          manifest.reviewedFrameCount === manifest.intendedFrameCount,
        modelComprehensionGuaranteed: false as const,
      });
    },
  };

  return Object.freeze({
    tools,
    createEvidenceResolver(manifest: EvidenceManifestLookup) {
      return createObservationTransferEvidenceResolver({
        manifest,
        evidenceStore: options.evidenceStore,
        cache: options.cache,
        currentAuthority: () => asTransferAuthority(options.currentAuthority()),
        readRecord: (requestedManifest) => {
          const record = recordsByManifestId.get(requestedManifest.manifestId);
          if (record === undefined || !sameManifestLookup(record.lookup, requestedManifest))
            return undefined;
          return toPayloadRecord(record);
        },
      });
    },
    createReviewCandidate(observationId: string): JoyAgentObservationReviewCandidate | undefined {
      if (typeof observationId !== 'string' || observationId.length === 0) return undefined;
      const record = recordsByObservationId.get(observationId);
      if (record === undefined || record.observationId !== observationId) return undefined;
      const authority = asTransferAuthority(options.currentAuthority());
      if (
        authority === undefined ||
        !sameTransferAuthority(authority, asTransferAuthority(record.authority))
      )
        return undefined;
      const manifest = options.evidenceStore.readManifest(record.lookup);
      if (
        manifest === undefined ||
        (manifest.status !== 'complete' && manifest.status !== 'partial') ||
        record.frames.length === 0
      )
        return undefined;
      const evidenceIds = candidateEvidenceIds(record);
      if (evidenceIds.length === 0) return undefined;
      return Object.freeze({
        authority: cloneTransferAuthority(authority),
        manifest: cloneManifestLookup(record.lookup),
        range: Object.freeze({ domain: 'source' as const, ...record.range }),
        evidenceIds: Object.freeze(evidenceIds),
      });
    },
    markReviewedEvidence(input: JoyAgentObservationReviewCandidate): boolean {
      if (!isReviewCandidate(input)) return false;
      const record = recordsByManifestId.get(input.manifest.manifestId);
      const current = asTransferAuthority(options.currentAuthority());
      if (
        record === undefined ||
        current === undefined ||
        !sameManifestLookup(record.lookup, input.manifest) ||
        !sameTransferAuthority(current, input.authority) ||
        !sameTransferAuthority(asTransferAuthority(record.authority), input.authority) ||
        input.range.domain !== 'source' ||
        input.range.startUs !== record.range.startUs ||
        input.range.endUs !== record.range.endUs ||
        !sameIds(input.evidenceIds, candidateEvidenceIds(record))
      )
        return false;
      try {
        if (
          !options.evidenceStore.recordFrames({
            manifestId: record.lookup.manifestId,
            scope: record.lookup.scope,
            stage: 'submitted',
            frameIds: [...input.evidenceIds],
          })
        )
          return false;
        return options.evidenceStore.recordFrames({
          manifestId: record.lookup.manifestId,
          scope: record.lookup.scope,
          stage: 'reviewed',
          frameIds: [...input.evidenceIds],
        });
      } catch {
        return false;
      }
    },
  });
}

async function preflightFramePlan(input: {
  readonly options: NormalizedOptions;
  readonly asset: NormalizedAssetMetadata;
  readonly authority: JoyAgentObservationCurrentAuthority;
  readonly range: JoyAgentObservationRange;
  readonly maxFrames: number;
  readonly signal: AbortSignal;
}): Promise<FramePlan> {
  const { options, asset, authority, range, maxFrames, signal } = input;
  throwIfAborted(signal);
  let source: ProjectMediaObservationSource;
  try {
    source = await options.resolver.resolveObservationSource(asset.assetId);
  } catch {
    throw new JoyAgentObservationToolAdapterError('source-unavailable');
  }
  throwIfAborted(signal);
  assertCurrentMatches(authority, options);
  assertLocalObservationSource(source);
  if (asset.streamId === undefined)
    throw new JoyAgentObservationToolAdapterError('unsupported-media');

  let stream: AsyncIterable<ObservationWorkerDecodedFrame>;
  try {
    stream = options.worker.frames(
      {
        assetDigest: asset.assetDigest,
        streamId: asset.streamId,
        source: source.blob,
        epoch: authority.run.epoch,
        range: Object.freeze({ ...range }),
      },
      signal,
    );
  } catch {
    throw new JoyAgentObservationToolAdapterError('observation-failed');
  }

  const frameIds: string[] = [];
  const seen = new Set<string>();
  let decodedThumbnailBytes = 0;
  let limited = false;
  try {
    for await (const frame of stream) {
      throwIfAborted(signal);
      assertCurrentMatches(authority, options);
      assertPreflightFrame(frame, asset, range);
      if (seen.has(frame.id)) throw new JoyAgentObservationToolAdapterError('observation-failed');
      seen.add(frame.id);
      if (frameIds.length >= maxFrames) {
        limited = true;
        break;
      }
      if (frame.thumbnail.byteLength > options.maxThumbnailBytes - decodedThumbnailBytes) {
        limited = true;
        break;
      }
      decodedThumbnailBytes += frame.thumbnail.byteLength;
      frameIds.push(frame.id);
    }
  } catch (error) {
    if (error instanceof JoyAgentObservationToolAdapterError) throw error;
    throw normalizeObservationError(error, signal);
  }
  return Object.freeze({ frameIds: Object.freeze(frameIds), limited });
}

function isObservationRunAuthorityCurrent(
  candidate: ObservationRunAuthority,
  options: NormalizedOptions,
): boolean {
  try {
    const rawCurrent = options.currentAuthority();
    const current = normalizeCurrentAuthority(rawCurrent, options.projectId);
    return (
      candidate.projectId === current.projectId &&
      candidate.projectRevision === current.revision &&
      candidate.run.runId === current.run.runId &&
      candidate.run.epoch === current.run.epoch &&
      candidate.modelId === current.modelId &&
      candidate.promptPolicyDigest === current.promptPolicyDigest
    );
  } catch {
    return false;
  }
}

function normalizeOptions(raw: CreateJoyAgentObservationToolAdapterOptions): NormalizedOptions {
  if (!isPlainRecord(raw)) throw new JoyAgentObservationToolAdapterError('invalid-request');
  assertSafeIdentifier(raw.projectId, 'projectId');
  if (
    raw.resolver === null ||
    typeof raw.resolver !== 'object' ||
    typeof raw.resolver.resolveObservationSource !== 'function' ||
    raw.worker === null ||
    typeof raw.worker !== 'object' ||
    typeof raw.worker.frames !== 'function' ||
    raw.evidenceStore === null ||
    typeof raw.evidenceStore !== 'object' ||
    raw.cache === null ||
    typeof raw.cache !== 'object' ||
    typeof raw.assetLookup !== 'function' ||
    typeof raw.currentAuthority !== 'function' ||
    (raw.digestThumbnail !== undefined && typeof raw.digestThumbnail !== 'function')
  )
    throw new JoyAgentObservationToolAdapterError('invalid-request');
  const maxThumbnailBytes = raw.maxThumbnailBytes ?? DEFAULT_MAX_THUMBNAIL_BYTES;
  if (
    !Number.isSafeInteger(maxThumbnailBytes) ||
    maxThumbnailBytes < 1 ||
    maxThumbnailBytes > MAX_THUMBNAIL_BYTES
  )
    throw new JoyAgentObservationToolAdapterError('invalid-request');
  return Object.freeze({
    projectId: raw.projectId,
    resolver: raw.resolver,
    worker: raw.worker,
    evidenceStore: raw.evidenceStore,
    cache: raw.cache,
    assetLookup: raw.assetLookup,
    currentAuthority: raw.currentAuthority,
    maxThumbnailBytes,
    digestThumbnail: raw.digestThumbnail,
  });
}

function requireCurrentAuthority(
  authority: JoyAgentObservationToolAuthority,
  options: NormalizedOptions,
): JoyAgentObservationCurrentAuthority {
  let rawCurrent: unknown;
  try {
    assertToolAuthority(authority, options.projectId);
    rawCurrent = options.currentAuthority();
    const current = normalizeCurrentAuthority(rawCurrent, options.projectId);
    if (
      current.projectId !== authority.projectId ||
      current.revision !== authority.revision ||
      current.run.runId !== authority.run.runId ||
      current.run.epoch !== authority.run.epoch
    ) {
      throw new Error();
    }
    return current;
  } catch {
    throw new JoyAgentObservationToolAdapterError('stale-authority');
  }
}

function assertCurrentMatches(
  expected: JoyAgentObservationCurrentAuthority,
  options: NormalizedOptions,
): void {
  let current: JoyAgentObservationCurrentAuthority;
  try {
    current = normalizeCurrentAuthority(options.currentAuthority(), options.projectId);
  } catch {
    throw new JoyAgentObservationToolAdapterError('stale-authority');
  }
  if (!sameAuthority(expected, current))
    throw new JoyAgentObservationToolAdapterError('stale-authority');
}

function normalizeCurrentAuthority(
  value: unknown,
  expectedProjectId: string,
): JoyAgentObservationCurrentAuthority {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['projectId', 'revision', 'run', 'modelId', 'promptPolicyDigest'])
  )
    throw new Error();
  if (value.projectId !== expectedProjectId) throw new Error();
  assertSafeIdentifier(value.projectId, 'projectId');
  assertSafeRevisionIdentifier(value.revision, 'revision');
  assertHostRun(value.run);
  assertSafeIdentifier(value.modelId, 'modelId');
  assertSafeIdentifier(value.promptPolicyDigest, 'promptPolicyDigest');
  return Object.freeze({
    projectId: value.projectId,
    revision: value.revision,
    run: Object.freeze({ runId: value.run.runId, epoch: value.run.epoch }),
    modelId: value.modelId,
    promptPolicyDigest: value.promptPolicyDigest,
  });
}

function normalizeAssetMetadata(
  value: JoyAgentObservationAssetMetadata,
  requestedAssetId: string,
): NormalizedAssetMetadata {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(
      value,
      [
        'assetId',
        'assetDigest',
        'kind',
        'durationUs',
        'streamCount',
        'streamId',
        'sourceVariant',
        'transcript',
      ],
      ['assetId', 'assetDigest', 'kind', 'durationUs', 'streamCount'],
    )
  )
    throw new JoyAgentObservationToolAdapterError('asset-unavailable');
  assertSafeIdentifier(value.assetId, 'assetId');
  assertSafeIdentifier(requestedAssetId, 'assetId');
  if (
    value.assetId !== requestedAssetId ||
    typeof value.assetDigest !== 'string' ||
    !SHA_256.test(value.assetDigest)
  )
    throw new JoyAgentObservationToolAdapterError('asset-unavailable');
  if (value.kind !== 'image' && value.kind !== 'audio' && value.kind !== 'video')
    throw new JoyAgentObservationToolAdapterError('asset-unavailable');
  if (
    typeof value.durationUs !== 'number' ||
    !Number.isSafeInteger(value.durationUs) ||
    value.durationUs < 0 ||
    value.durationUs > MAX_TOOL_TIME_US ||
    typeof value.streamCount !== 'number' ||
    !Number.isSafeInteger(value.streamCount) ||
    value.streamCount < 1 ||
    value.streamCount > 128
  )
    throw new JoyAgentObservationToolAdapterError('asset-unavailable');
  if (value.kind === 'video' && value.durationUs < 1)
    throw new JoyAgentObservationToolAdapterError('asset-unavailable');
  const streamId =
    value.streamId === undefined
      ? undefined
      : assertAndReturnIdentifier(value.streamId, 'streamId');
  const sourceVariant =
    value.sourceVariant === undefined ? undefined : normalizeSourceVariant(value.sourceVariant);
  if (value.kind === 'video' && (streamId === undefined || sourceVariant === undefined))
    throw new JoyAgentObservationToolAdapterError('asset-unavailable');
  return Object.freeze({
    assetId: value.assetId,
    assetDigest: value.assetDigest.toLowerCase(),
    kind: value.kind,
    durationUs: value.durationUs,
    streamCount: value.streamCount,
    ...(streamId === undefined ? {} : { streamId }),
    ...(sourceVariant === undefined ? {} : { sourceVariant }),
    ...(value.transcript === undefined
      ? {}
      : { transcript: normalizeTranscript(value.transcript) }),
  });
}

function normalizeSourceVariant(value: ObservationSourceVariant): ObservationSourceVariant {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['crop', 'rotationDeg', 'representation', 'analysisVersion'])
  )
    throw new JoyAgentObservationToolAdapterError('asset-unavailable');
  if (!isPlainRecord(value.crop) || !hasExactKeys(value.crop, ['x', 'y', 'width', 'height']))
    throw new JoyAgentObservationToolAdapterError('asset-unavailable');
  const { x, y, width, height } = value.crop;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    (value.rotationDeg !== 0 &&
      value.rotationDeg !== 90 &&
      value.rotationDeg !== 180 &&
      value.rotationDeg !== 270) ||
    (value.representation !== 'original' && value.representation !== 'proxy')
  )
    throw new JoyAgentObservationToolAdapterError('asset-unavailable');
  assertSafeIdentifier(value.analysisVersion, 'analysisVersion');
  return Object.freeze({
    crop: Object.freeze({ x, y, width, height }),
    rotationDeg: value.rotationDeg,
    representation: value.representation,
    analysisVersion: value.analysisVersion,
  });
}

function normalizeTranscript(
  value: NonNullable<JoyAgentObservationAssetMetadata['transcript']>,
): NormalizedTranscript {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['transcriptId', 'language', 'items']))
    throw new JoyAgentObservationToolAdapterError('asset-unavailable');
  assertSafeIdentifier(value.transcriptId, 'transcriptId');
  if (
    typeof value.language !== 'string' ||
    !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(value.language)
  )
    throw new JoyAgentObservationToolAdapterError('asset-unavailable');
  if (!Array.isArray(value.items) || value.items.length > MAX_TRANSCRIPT_ITEMS)
    throw new JoyAgentObservationToolAdapterError('asset-unavailable');
  return Object.freeze({
    transcriptId: value.transcriptId,
    language: value.language,
    items: Object.freeze(value.items.map((item) => normalizeTranscriptItem(item))),
  });
}

function normalizeTranscriptItem(
  value: JoyAgentTranscriptTimingMetadata,
): JoyAgentTranscriptWordMetadata {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(
      value,
      ['id', 'startUs', 'endUs', 'confidence', 'speakerId'],
      ['id', 'startUs', 'endUs'],
    )
  )
    throw new JoyAgentObservationToolAdapterError('asset-unavailable');
  assertSafeIdentifier(value.id, 'transcript item id');
  if (
    typeof value.startUs !== 'number' ||
    typeof value.endUs !== 'number' ||
    !Number.isSafeInteger(value.startUs) ||
    !Number.isSafeInteger(value.endUs) ||
    value.startUs < 0 ||
    value.endUs <= value.startUs ||
    (value.confidence !== undefined &&
      (typeof value.confidence !== 'number' ||
        !Number.isFinite(value.confidence) ||
        value.confidence < 0 ||
        value.confidence > 1))
  )
    throw new JoyAgentObservationToolAdapterError('asset-unavailable');
  const speakerId =
    value.speakerId === undefined
      ? undefined
      : assertAndReturnIdentifier(value.speakerId, 'speakerId');
  return Object.freeze({
    id: value.id,
    startUs: value.startUs,
    endUs: value.endUs,
    ...(value.confidence === undefined ? {} : { confidence: value.confidence }),
    ...(speakerId === undefined ? {} : { speakerId }),
  });
}

function assertDescribeRequest(value: JoyAgentMediaDescribeRequest): void {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['assetId']))
    throw new JoyAgentObservationToolAdapterError('invalid-request');
  assertSafeIdentifier(value.assetId, 'assetId');
}

function assertObserveRequest(value: JoyAgentMediaObserveRequest): void {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['assetId', 'range', 'mode', 'maxFrames', 'maxMetadataBytes'])
  )
    throw new JoyAgentObservationToolAdapterError('invalid-request');
  assertSafeIdentifier(value.assetId, 'assetId');
  assertRange(value.range);
  if (
    !OBSERVATION_MODES.includes(value.mode) ||
    !Number.isSafeInteger(value.maxFrames) ||
    value.maxFrames < 1 ||
    value.maxFrames > MAX_TOOL_FRAMES ||
    !Number.isSafeInteger(value.maxMetadataBytes) ||
    value.maxMetadataBytes < 1 ||
    value.maxMetadataBytes > MAX_TOOL_METADATA_BYTES
  )
    throw new JoyAgentObservationToolAdapterError('invalid-request');
}

function assertFramesRequest(value: JoyAgentMediaFramesRequest): void {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['observationId', 'cursor', 'pageSize']))
    throw new JoyAgentObservationToolAdapterError('invalid-request');
  assertSafeIdentifier(value.observationId, 'observationId');
  assertPage(value.cursor, value.pageSize);
}

function assertTranscriptRequest(value: JoyAgentMediaTranscriptRequest): void {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['assetId', 'range', 'cursor', 'pageSize']))
    throw new JoyAgentObservationToolAdapterError('invalid-request');
  assertSafeIdentifier(value.assetId, 'assetId');
  assertRange(value.range);
  assertPage(value.cursor, value.pageSize);
}

function assertEvidenceReadRequest(value: JoyAgentEvidenceReadRequest): void {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['manifestId', 'pageIndex']))
    throw new JoyAgentObservationToolAdapterError('invalid-request');
  assertSafeIdentifier(value.manifestId, 'manifestId');
  if (
    !Number.isSafeInteger(value.pageIndex) ||
    value.pageIndex < 0 ||
    value.pageIndex > MAX_TOOL_CURSOR
  )
    throw new JoyAgentObservationToolAdapterError('invalid-request');
}

function assertEvidenceCoverageRequest(value: JoyAgentEvidenceCoverageRequest): void {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['manifestId']))
    throw new JoyAgentObservationToolAdapterError('invalid-request');
  assertSafeIdentifier(value.manifestId, 'manifestId');
}

function assertRange(value: JoyAgentObservationRange): void {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['startUs', 'endUs']))
    throw new JoyAgentObservationToolAdapterError('invalid-request');
  if (
    !Number.isSafeInteger(value.startUs) ||
    !Number.isSafeInteger(value.endUs) ||
    value.startUs < 0 ||
    value.endUs <= value.startUs ||
    value.endUs > MAX_TOOL_TIME_US ||
    value.endUs - value.startUs > MAX_RANGE_US
  )
    throw new JoyAgentObservationToolAdapterError('invalid-request');
}

function assertRangeWithinAsset(range: JoyAgentObservationRange, durationUs: number): void {
  if (range.endUs > durationUs) throw new JoyAgentObservationToolAdapterError('invalid-request');
}

function assertPage(cursor: number, pageSize: number): void {
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    cursor > MAX_TOOL_CURSOR ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_TOOL_PAGE_SIZE
  )
    throw new JoyAgentObservationToolAdapterError('invalid-request');
}

function assertToolAuthority(
  value: JoyAgentObservationToolAuthority,
  expectedProjectId: string,
): void {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['projectId', 'revision', 'run']))
    throw new Error();
  if (value.projectId !== expectedProjectId) throw new Error();
  assertSafeIdentifier(value.projectId, 'projectId');
  assertSafeRevisionIdentifier(value.revision, 'revision');
  assertHostRun(value.run);
}

function assertHostRun(value: unknown): asserts value is JoyAgentObservationToolAuthority['run'] {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['runId', 'epoch'])) throw new Error();
  const runId = value.runId;
  const epoch = value.epoch;
  if (
    typeof runId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) ||
    typeof epoch !== 'number' ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1
  )
    throw new Error();
}

function asToolObservationMode(value: string): JoyAgentMediaObserveRequest['mode'] {
  if (!OBSERVATION_MODES.includes(value as JoyAgentMediaObserveRequest['mode']))
    throw new JoyAgentObservationToolAdapterError('manifest-unavailable');
  return value as JoyAgentMediaObserveRequest['mode'];
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
    throw new JoyAgentObservationToolAdapterError('source-unavailable');
}

function assertPreflightFrame(
  value: ObservationWorkerDecodedFrame,
  asset: NormalizedAssetMetadata,
  range: JoyAgentObservationRange,
): void {
  try {
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, [
        'id',
        'identity',
        'actualTimeUs',
        'durationUs',
        'presentationIndex',
        'width',
        'height',
        'thumbnail',
      ])
    )
      throw new Error();
    assertFrameIdentity(value.identity);
    if (
      value.id !== frameIdentityKey(value.identity) ||
      value.identity.assetDigest.toLowerCase() !== asset.assetDigest ||
      value.identity.streamId !== asset.streamId ||
      value.actualTimeUs !== value.identity.sourceTimeUs ||
      value.durationUs !== value.identity.durationUs ||
      value.presentationIndex !== value.identity.presentationIndex ||
      !Number.isSafeInteger(value.actualTimeUs) ||
      !Number.isSafeInteger(value.durationUs) ||
      value.actualTimeUs < 0 ||
      value.actualTimeUs > MAX_TOOL_TIME_US ||
      value.durationUs < 1 ||
      value.durationUs > MAX_TOOL_TIME_US ||
      !Number.isSafeInteger(value.presentationIndex) ||
      value.presentationIndex < 0 ||
      value.presentationIndex > MAX_TOOL_CURSOR ||
      !Number.isSafeInteger(value.width) ||
      !Number.isSafeInteger(value.height) ||
      value.width < 1 ||
      value.width > MAX_TOOL_DIMENSION ||
      value.height < 1 ||
      value.height > MAX_TOOL_DIMENSION ||
      !intersectsRange(value.actualTimeUs, value.durationUs, range) ||
      !isValidThumbnail(value.thumbnail)
    )
      throw new Error();
    assertSafeIdentifier(value.id, 'frameId', MAX_FRAME_IDENTIFIER_LENGTH);
  } catch {
    throw new JoyAgentObservationToolAdapterError('observation-failed');
  }
}

function isValidThumbnail(value: unknown): value is ObservationWorkerDecodedFrame['thumbnail'] {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['blob', 'width', 'height', 'byteLength', 'mimeType'])
  )
    return false;
  return (
    value.blob instanceof Blob &&
    typeof value.width === 'number' &&
    Number.isSafeInteger(value.width) &&
    value.width > 0 &&
    typeof value.height === 'number' &&
    Number.isSafeInteger(value.height) &&
    value.height > 0 &&
    typeof value.byteLength === 'number' &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength > 0 &&
    value.byteLength === value.blob.size &&
    (value.mimeType === 'image/jpeg' || value.mimeType === 'image/png') &&
    value.blob.type === value.mimeType
  );
}

function pageFrameIds(frameIds: readonly string[]): readonly (readonly string[])[] {
  const pages: string[][] = [];
  for (let start = 0; start < frameIds.length; start += MAX_TOOL_FRAMES)
    pages.push([...frameIds.slice(start, start + MAX_TOOL_FRAMES)]);
  return Object.freeze(pages.map((page) => Object.freeze(page)));
}

function framePageIndex(frameIds: readonly string[]): ReadonlyMap<string, number> {
  const pages = new Map<string, number>();
  for (const [index, frameId] of frameIds.entries())
    pages.set(frameId, Math.floor(index / MAX_TOOL_FRAMES));
  return pages;
}

function cacheIdentityFor(
  asset: NormalizedAssetMetadata,
  authority: JoyAgentObservationCurrentAuthority,
): ObservationCacheIdentity {
  if (asset.streamId === undefined || asset.sourceVariant === undefined)
    throw new JoyAgentObservationToolAdapterError('unsupported-media');
  return Object.freeze({
    projectId: authority.projectId,
    assetDigest: asset.assetDigest,
    projectRevision: authority.revision,
    modelId: authority.modelId,
    promptPolicyDigest: authority.promptPolicyDigest,
    streamId: asset.streamId,
    crop: Object.freeze({ ...asset.sourceVariant.crop }),
    rotationDeg: asset.sourceVariant.rotationDeg,
    representation: asset.sourceVariant.representation,
    analysisVersion: asset.sourceVariant.analysisVersion,
  });
}

function asTransferAuthority(
  value: JoyAgentObservationCurrentAuthority | undefined,
): ObservationTransferAuthority | undefined {
  try {
    if (value === undefined) return undefined;
    return Object.freeze({
      projectId: value.projectId,
      revision: value.revision,
      run: Object.freeze({ runId: value.run.runId, epoch: value.run.epoch }),
      modelId: value.modelId,
      promptPolicyDigest: value.promptPolicyDigest,
    });
  } catch {
    return undefined;
  }
}

function cloneTransferAuthority(value: ObservationTransferAuthority): ObservationTransferAuthority {
  return Object.freeze({ ...value, run: Object.freeze({ ...value.run }) });
}

function sameTransferAuthority(
  left: ObservationTransferAuthority | undefined,
  right: ObservationTransferAuthority | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.projectId === right.projectId &&
    left.revision === right.revision &&
    left.run.runId === right.run.runId &&
    left.run.epoch === right.run.epoch &&
    left.modelId === right.modelId &&
    left.promptPolicyDigest === right.promptPolicyDigest
  );
}

function cloneManifestLookup(value: EvidenceManifestLookup): EvidenceManifestLookup {
  return Object.freeze({
    manifestId: value.manifestId,
    scope: Object.freeze({
      runId: value.scope.runId,
      identity: Object.freeze({ ...value.scope.identity }),
    }),
  });
}

function candidateEvidenceIds(record: ObservationRecord): readonly string[] {
  return Object.freeze(
    record.frames
      .slice(0, 16)
      .map((frame) => frame.id)
      .filter((id) => record.frameMimeTypes.has(id)),
  );
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isReviewCandidate(value: unknown): value is JoyAgentObservationReviewCandidate {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['authority', 'manifest', 'range', 'evidenceIds'])
  )
    return false;
  const authority = value.authority;
  const range = value.range;
  return (
    isPlainRecord(authority) &&
    isPlainRecord(authority.run) &&
    typeof authority.projectId === 'string' &&
    typeof authority.revision === 'string' &&
    typeof authority.modelId === 'string' &&
    typeof authority.promptPolicyDigest === 'string' &&
    typeof authority.run.runId === 'string' &&
    typeof authority.run.epoch === 'number' &&
    isPlainRecord(range) &&
    range.domain === 'source' &&
    typeof range.startUs === 'number' &&
    typeof range.endUs === 'number' &&
    Array.isArray(value.evidenceIds) &&
    value.evidenceIds.length > 0 &&
    value.evidenceIds.length <= 16 &&
    value.evidenceIds.every((id) => typeof id === 'string')
  );
}

function toPayloadRecord(record: ObservationRecord): ObservationPayloadRecord {
  return Object.freeze({
    manifest: Object.freeze({
      manifestId: record.lookup.manifestId,
      scope: Object.freeze({
        runId: record.lookup.scope.runId,
        identity: Object.freeze({ ...record.lookup.scope.identity }),
      }),
    }),
    authority: Object.freeze({
      projectId: record.authority.projectId,
      revision: record.authority.revision,
      run: Object.freeze({ ...record.authority.run }),
      modelId: record.authority.modelId,
      promptPolicyDigest: record.authority.promptPolicyDigest,
    }),
    range: Object.freeze({ ...record.range }),
    cacheIdentity: Object.freeze({
      ...record.cacheIdentity,
      crop: Object.freeze({ ...record.cacheIdentity.crop }),
    }),
    // The transfer resolver receives an isolated metadata snapshot, never the
    // mutable maps owned by the ongoing observation record.
    frameMimeTypes: new Map(record.frameMimeTypes),
    framePageById: new Map(record.framePageById),
  });
}

function sameManifestLookup(left: EvidenceManifestLookup, right: EvidenceManifestLookup): boolean {
  return (
    left.manifestId === right.manifestId &&
    left.scope.runId === right.scope.runId &&
    left.scope.identity.projectId === right.scope.identity.projectId &&
    left.scope.identity.assetDigest.toLowerCase() ===
      right.scope.identity.assetDigest.toLowerCase() &&
    left.scope.identity.projectRevision === right.scope.identity.projectRevision &&
    left.scope.identity.modelId === right.scope.identity.modelId &&
    left.scope.identity.promptPolicyDigest === right.scope.identity.promptPolicyDigest
  );
}

function nextManifestId(
  authority: JoyAgentObservationCurrentAuthority,
  next: () => number,
): string {
  const runHash = opaqueHash(authority.run.runId);
  return `obs-${runHash}-${authority.run.epoch.toString(36)}-${next().toString(36)}`;
}

function fallbackTranscriptId(assetId: string): string {
  return `transcript-${opaqueHash(assetId)}`;
}

function opaqueHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function terminalStatusForError(error: unknown, signal: AbortSignal): EvidenceCoverageStatus {
  if (signal.aborted) return 'cancelled';
  if (
    error instanceof JoyAgentObservationToolAdapterError &&
    (error.code === 'cancelled' || error.code === 'stale-authority')
  )
    return 'cancelled';
  if (
    error instanceof ObservationServiceError &&
    (error.code === 'cancelled' || error.code === 'stale-authority')
  )
    return 'cancelled';
  return 'failed';
}

function normalizeObservationError(
  error: unknown,
  signal: AbortSignal,
): JoyAgentObservationToolAdapterError {
  if (signal.aborted) return new JoyAgentObservationToolAdapterError('cancelled');
  if (error instanceof JoyAgentObservationToolAdapterError) return error;
  if (error instanceof ObservationServiceError) {
    if (error.code === 'cancelled') return new JoyAgentObservationToolAdapterError('cancelled');
    if (error.code === 'stale-authority')
      return new JoyAgentObservationToolAdapterError('stale-authority');
    if (error.code === 'source-unavailable')
      return new JoyAgentObservationToolAdapterError('source-unavailable');
  }
  return new JoyAgentObservationToolAdapterError('observation-failed');
}

function cloneAuthority(
  value: JoyAgentObservationCurrentAuthority,
): JoyAgentObservationCurrentAuthority {
  return Object.freeze({
    projectId: value.projectId,
    revision: value.revision,
    run: Object.freeze({ ...value.run }),
    modelId: value.modelId,
    promptPolicyDigest: value.promptPolicyDigest,
  });
}

function sameAuthority(
  left: JoyAgentObservationCurrentAuthority,
  right: JoyAgentObservationCurrentAuthority,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.revision === right.revision &&
    left.run.runId === right.run.runId &&
    left.run.epoch === right.run.epoch &&
    left.modelId === right.modelId &&
    left.promptPolicyDigest === right.promptPolicyDigest
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new JoyAgentObservationToolAdapterError('cancelled');
}

function assertSafeIdentifier(
  value: unknown,
  _label: string,
  maxLength = MAX_IDENTIFIER_LENGTH,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    !OPAQUE_IDENTIFIER.test(value) ||
    UNSAFE_LOCATION.test(value)
  )
    throw new JoyAgentObservationToolAdapterError('invalid-request');
}

function assertSafeRevisionIdentifier(
  value: unknown,
  _label: string,
  maxLength = MAX_REVISION_IDENTIFIER_LENGTH,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    !OPAQUE_IDENTIFIER.test(value) ||
    UNSAFE_LOCATION.test(value)
  )
    throw new JoyAgentObservationToolAdapterError('invalid-request');
}

function assertAndReturnIdentifier(value: unknown, label: string): string {
  try {
    assertSafeIdentifier(value, label);
    return value;
  } catch {
    throw new JoyAgentObservationToolAdapterError('asset-unavailable');
  }
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
