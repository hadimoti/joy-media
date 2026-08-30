import { createHash } from 'node:crypto';
import { CREATIVE_BRIEF_CONSENT_VERSION } from './creative-brief-runtime-config.js';
import { JOY_CODE_CONSENT_VERSION } from './joy-code-consent.js';

export interface Actor {
  readonly id: string;
}

/** Only this service identity may publish cross-account library media. */
export const SHARED_LIBRARY_OWNER_ID = 'joy-media-library';
export const MAX_WORKER_ATTEMPTS = 2_147_483_647;
const WORKER_ATTEMPT_BUDGET_EXHAUSTED = 'Worker attempt budget exhausted';
/**
 * Provider jobs are intentionally fail-closed until their result contract is
 * durable in the control plane. Local GPU jobs (including image.comfy) have
 * verified receipt and derivative paths and are therefore not listed here.
 */
export const UNSUPPORTED_PROVIDER_JOB_TYPES = [
  'text.openrouter',
  'video.runway',
  'edit.higgsfield',
] as const;
const UNSUPPORTED_PROVIDER_JOB_TYPE_SET = new Set<string>(UNSUPPORTED_PROVIDER_JOB_TYPES);

export function assertSupportedWorkerJobType(type: string): void {
  if (UNSUPPORTED_PROVIDER_JOB_TYPE_SET.has(type))
    throw new ControlPlaneError(
      'JOB_TYPE_UNSUPPORTED',
      `${type} is unavailable until its durable Worker result contract is implemented`,
    );
}

// Project Document Store types and implementations
// Using local types to avoid module resolution issues with verbatimModuleSyntax
type InternalProjectId = string;
type InternalOwnerId = string;

interface InternalProjectDocumentRecord {
  readonly projectId: InternalProjectId;
  readonly ownerId: InternalOwnerId;
  readonly revisionId: string;
  readonly document: unknown;
}

type InternalProjectDocumentReadOutcome =
  | { readonly kind: 'ready'; readonly record: InternalProjectDocumentRecord }
  | {
      readonly kind: 'not-found';
      readonly projectId: InternalProjectId;
      readonly revisionId: string | null;
    }
  | {
      readonly kind: 'stale-revision';
      readonly projectId: InternalProjectId;
      readonly requestedRevisionId: string;
      readonly currentRevisionId: string;
    }
  | { readonly kind: 'unavailable'; readonly message: string };

type InternalProjectDocumentWriteOutcome =
  | {
      readonly kind: 'stored';
      readonly projectId: InternalProjectId;
      readonly ownerId: InternalOwnerId;
      readonly revisionId: string;
    }
  | { readonly kind: 'not-found'; readonly projectId: InternalProjectId }
  | {
      readonly kind: 'owner-denied';
      readonly projectId: InternalProjectId;
      readonly ownerId: InternalOwnerId;
      readonly callerId: InternalOwnerId;
    }
  | {
      readonly kind: 'revision-conflict';
      readonly projectId: InternalProjectId;
      readonly expectedBaseRevisionId: string;
      readonly actualBaseRevisionId: string;
    }
  | {
      readonly kind: 'invalid-document';
      readonly projectId: InternalProjectId;
      readonly diagnostics: readonly {
        readonly code: string;
        readonly message: string;
        readonly path: string;
      }[];
    }
  | { readonly kind: 'unavailable'; readonly message: string };

type InternalProjectOwnerLookup = (projectId: InternalProjectId) => InternalOwnerId | undefined;

const INTERNAL_INITIAL_REVISION = '';

class InternalInMemoryProjectDocumentStore {
  private readonly store: Map<
    InternalProjectId,
    { readonly ownerId: InternalOwnerId; readonly revisionId: string; readonly document: unknown }
  > = new Map();
  private readonly revisions: Map<InternalProjectId, Set<string>> = new Map();

  constructor(private readonly lookupOwner: InternalProjectOwnerLookup) {}

  readDocument(
    callerId: InternalOwnerId,
    projectId: InternalProjectId,
    revisionId?: string,
  ): InternalProjectDocumentReadOutcome {
    const ownerId = this.lookupOwner(projectId);
    if (ownerId === undefined) {
      return { kind: 'not-found', projectId, revisionId: revisionId ?? null };
    }
    if (ownerId !== callerId) {
      return { kind: 'not-found', projectId, revisionId: revisionId ?? null };
    }
    const current = this.store.get(projectId);
    if (current === undefined) {
      return { kind: 'not-found', projectId, revisionId: revisionId ?? null };
    }
    if (revisionId !== undefined && revisionId !== current.revisionId) {
      return {
        kind: 'stale-revision',
        projectId,
        requestedRevisionId: revisionId,
        currentRevisionId: current.revisionId,
      };
    }
    return {
      kind: 'ready',
      record: {
        projectId,
        ownerId,
        revisionId: current.revisionId,
        document: this.deepCopy(current.document),
      },
    };
  }

  writeDocument(
    callerId: InternalOwnerId,
    record: InternalProjectDocumentRecord,
    baseRevisionId: string,
  ): InternalProjectDocumentWriteOutcome {
    const ownerId = this.lookupOwner(record.projectId);
    if (ownerId === undefined) {
      return { kind: 'not-found', projectId: record.projectId };
    }
    if (ownerId !== callerId) {
      return { kind: 'owner-denied', projectId: record.projectId, ownerId, callerId };
    }
    if (record.ownerId !== ownerId) {
      return { kind: 'owner-denied', projectId: record.projectId, ownerId, callerId };
    }
    const current = this.store.get(record.projectId);
    const currentRevisionId = current?.revisionId ?? INTERNAL_INITIAL_REVISION;
    if (baseRevisionId !== currentRevisionId) {
      return {
        kind: 'revision-conflict',
        projectId: record.projectId,
        expectedBaseRevisionId: baseRevisionId,
        actualBaseRevisionId: currentRevisionId,
      };
    }
    this.store.set(record.projectId, {
      ownerId,
      revisionId: record.revisionId,
      document: this.deepCopy(record.document),
    });
    let revSet = this.revisions.get(record.projectId);
    if (revSet === undefined) {
      revSet = new Set();
      this.revisions.set(record.projectId, revSet);
    }
    revSet.add(record.revisionId);
    return {
      kind: 'stored',
      projectId: record.projectId,
      ownerId: record.ownerId,
      revisionId: record.revisionId,
    };
  }

  private deepCopy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
  }
}

export interface ProjectMetadata {
  readonly id: string;
  readonly title: string;
  readonly revision: number;
  readonly ownerId: string;
  /** Always true: originals and eligible derivatives use private durable storage. */
  readonly assetSyncEnabled: boolean;
  readonly trashedAt?: number;
  /** Per-project Creative Brief opt-in flag. Defaults to false. */
  readonly creativeBriefOptIn: boolean;
}

export interface JoyCodeOptInStatus {
  readonly enabled: boolean;
  readonly consentVersion?: string;
  readonly revision: number;
}

export interface ProjectLifecycleMetadata extends ProjectMetadata {
  readonly activeJobCount: number;
}

export interface ProjectDuplicateResult {
  readonly project: ProjectMetadata;
  readonly assetIdMap: Readonly<Record<string, string>>;
  readonly derivativeIdMap: Readonly<Record<string, string>>;
}
export type MediaAssetKind = 'video' | 'audio' | 'image';
export type DerivativeKind = 'thumbnail' | 'proxy' | 'audio' | 'mask' | 'upscale';
export type DerivativeAvailability =
  'pending' | 'available-local' | 'available-cloud' | 'evicted' | 'invalid';

/** An opaque browser/cache or private-store reference, never a path or URL. */
export interface AssetLocationRecord {
  readonly kind: 'opfs-cache' | 'private-object';
  readonly ref: string;
}

/** Safe media facts that describe bytes without containing or locating them. */
export interface MediaDescriptor {
  readonly mimeType: string;
  readonly durationUs?: number;
  readonly width?: number;
  readonly height?: number;
  readonly animation?: MediaAnimationDescriptor;
}

export interface MediaAnimationDescriptor {
  readonly frameCount: number;
  readonly cycleDurationUs: number;
  /** Zero means the source declares infinite looping. */
  readonly loopCount: number;
  readonly hasAlpha: boolean;
}

export interface MediaAssetRecord {
  readonly id: string;
  readonly projectId: string;
  readonly kind: MediaAssetKind;
  readonly displayName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: MediaDescriptor;
  readonly locations: readonly AssetLocationRecord[];
  /** Hermes / catalog tags (lowercase opaque tokens). */
  readonly tags: readonly string[];
  /** Normalized name for alphabetical catalog sorting. */
  readonly sortName: string;
  readonly createdAt: number;
}

export interface MediaDerivativeRecord {
  readonly id: string;
  readonly projectId: string;
  readonly assetId: string;
  readonly kind: DerivativeKind;
  readonly profile: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: MediaDescriptor;
  readonly availability: DerivativeAvailability;
  readonly locations: readonly AssetLocationRecord[];
  readonly verifiedAt: number;
}

export interface AssetRegistration {
  readonly id: string;
  readonly kind: MediaAssetKind;
  readonly displayName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: MediaDescriptor;
  readonly locations: readonly AssetLocationRecord[];
}

export interface AssetDeletionResult {
  readonly id: string;
  /** Internal opaque refs that no remaining asset or derivative still uses. */
  readonly orphanedPrivateObjectRefs: readonly string[];
}

export interface ProjectDeletionResult {
  readonly id: string;
  readonly orphanedPrivateObjectRefs: readonly string[];
}

/** The browser may only register a local/pending derivative; cloud state is API-owned later. */
export interface LocalDerivativeRegistration {
  readonly id: string;
  readonly assetId: string;
  readonly kind: DerivativeKind;
  readonly profile: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: MediaDescriptor;
  /** Browser catalog HTTP permits only locally-owned cache state. */
  readonly availability: 'pending' | 'available-local';
  readonly locations: readonly AssetLocationRecord[];
}
/** Server-only promotion record; never accepted by the owner browser catalog route. */
export type CloudDerivativeRegistration = Omit<LocalDerivativeRegistration, 'availability'> & {
  readonly availability: 'available-cloud';
};
export interface WorkerRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly paired: boolean;
  readonly revoked: boolean;
  readonly capabilities: readonly string[];
  /** Opaque asset IDs present on the Worker; never local paths. */
  readonly localAssetIds: readonly string[];
  readonly lastSeenAt?: number;
  readonly modelInventory?: WorkerModelInventoryRecord;
}
export interface WorkerModelInventoryRecord {
  readonly managerVersion: string;
  readonly cacheStatus: 'ready' | 'read-only' | 'unavailable';
  readonly freeBytes?: number;
  readonly models: readonly {
    readonly modelId: string;
    readonly version: string;
    readonly state: string;
    readonly progress?: number;
    readonly installedBytes?: number;
    readonly errorCode?: string;
  }[];
}
export interface WorkerPairingOffer {
  readonly workerId: string;
  readonly expiresAt: number;
}
export interface WorkerSession {
  readonly workerId: string;
  readonly expiresAt: number;
}
export interface Job {
  readonly id: string;
  readonly projectId: string;
  readonly type: string;
  readonly assetId?: string;
  /** Validated JSON delivered only to the leased Worker, never to browser job listings. */
  readonly payload?: Readonly<Record<string, unknown>>;
  /** Optional per-job lease-attempt budget; omitted legacy jobs remain unbounded. */
  readonly maxAttempts?: number;
  /** Manual retry generation; attempt budgets are scoped to this generation. */
  readonly generation: number;
  readonly state: 'queued' | 'leased' | 'completed' | 'canceled' | 'failed';
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: number;
  /** Opaque per-lease token; stale completions cannot reuse a worker identity. */
  readonly leaseToken?: string;
  readonly progress: number;
  readonly cancelRequested: boolean;
  /** Safe, server-verified derivative metadata; never a local file or media payload. */
  readonly derivative?: DerivativeRecord;
  readonly error?: string;
}
export interface FixtureThumbnailReceipt {
  /** A receipt only: local paths and media bytes never leave the Worker. */
  readonly kind: 'fixture.thumbnail';
  readonly sha256: string;
  readonly bytes: number;
}
export interface AssetThumbnailReceipt {
  /** A verified local thumbnail result; `localRef` is opaque and Worker-local. */
  readonly kind: 'asset.thumbnail';
  readonly assetId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly localRef: string;
  readonly descriptor: {
    readonly mimeType: 'image/jpeg';
    readonly width: number;
    readonly height: number;
  };
}
/** Local GPU Worker derivative (Comfy / ML denoise) — ADR-0018. */
export interface LocalGpuWorkerReceipt {
  readonly kind: 'image.comfy' | 'audio.ml-denoise';
  readonly assetId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly localRef: string;
  readonly descriptor: {
    readonly mimeType: string;
    readonly width?: number;
    readonly height?: number;
    readonly durationUs?: number;
  };
}
/** Promptable image/video segmentation result retained by the Local Worker. */
export interface MaskWorkerReceipt {
  readonly kind: 'mask.image' | 'mask.video';
  readonly assetId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly localRef: string;
  readonly descriptor: {
    readonly mimeType: string;
    readonly width?: number;
    readonly height?: number;
    readonly durationUs?: number;
  };
}
/** AI upscaling result retained by the Local Worker. */
export interface UpscaleWorkerReceipt {
  readonly kind: 'upscale.image' | 'upscale.video';
  readonly assetId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly localRef: string;
  readonly descriptor: {
    readonly mimeType: string;
    readonly width?: number;
    readonly height?: number;
    readonly durationUs?: number;
  };
  readonly modelId?: string;
  readonly modelVersion?: string;
}
export type WorkerResultReceipt =
  | FixtureThumbnailReceipt
  | AssetThumbnailReceipt
  | LocalGpuWorkerReceipt
  | MaskWorkerReceipt
  | UpscaleWorkerReceipt;
/**
 * Owner-visible derivative projection. All references are control-plane IDs;
 * it deliberately has no Worker path, bytes, pairing secret, or session token.
 */
export type DerivativeRecord = WorkerResultReceipt & {
  readonly jobId: string;
  readonly workerRef: string;
  readonly resultRef: string;
  readonly verifiedAt: number;
};
const FIXTURE_THUMBNAIL_SHA256 = '78bf4c43aa7ab3a14c9f1e34f3333f9f612a08191affba3fb9c3e6de88378735';
const FIXTURE_THUMBNAIL_BYTES = 14;
export interface JobEvent {
  readonly cursor: number;
  readonly jobId: string;
  readonly type: string;
  readonly at: number;
}

/** The API transport can use the synchronous local spike or durable PostgreSQL. */
export interface ControlPlane {
  createProject(
    actor: Actor,
    id: string,
    title: string,
  ): ProjectMetadata | Promise<ProjectMetadata>;
  updateProject(
    actor: Actor,
    id: string,
    title: string,
    baseRevision: number,
  ): ProjectMetadata | Promise<ProjectMetadata>;
  getProject(
    actor: Actor,
    id: string,
  ): ProjectLifecycleMetadata | Promise<ProjectLifecycleMetadata>;
  duplicateProject(
    actor: Actor,
    sourceId: string,
    id: string,
    title: string,
    baseRevision: number,
  ): ProjectDuplicateResult | Promise<ProjectDuplicateResult>;
  trashProject(
    actor: Actor,
    id: string,
    baseRevision: number,
    now?: number,
  ): ProjectMetadata | Promise<ProjectMetadata>;
  restoreProject(
    actor: Actor,
    id: string,
    baseRevision: number,
  ): ProjectMetadata | Promise<ProjectMetadata>;
  deleteProject(actor: Actor, id: string): ProjectDeletionResult | Promise<ProjectDeletionResult>;
  setAssetSync(
    actor: Actor,
    projectId: string,
    enabled: boolean,
  ): ProjectMetadata | Promise<ProjectMetadata>;
  getCreativeBriefOptIn(actor: Actor, projectId: string): boolean | Promise<boolean>;
  setCreativeBriefOptIn(
    actor: Actor,
    projectId: string,
    enabled: boolean,
    baseRevision: number,
  ): ProjectMetadata | Promise<ProjectMetadata>;
  getJoyCodeOptIn(
    actor: Actor,
    projectId: string,
  ): JoyCodeOptInStatus | Promise<JoyCodeOptInStatus>;
  setJoyCodeOptIn(
    actor: Actor,
    projectId: string,
    enabled: boolean,
    consentVersion: string | undefined,
    baseRevision: number,
  ): ProjectMetadata | Promise<ProjectMetadata>;
  registerAsset(
    actor: Actor,
    projectId: string,
    asset: AssetRegistration,
    now?: number,
  ): MediaAssetRecord | Promise<MediaAssetRecord>;
  /**
   * Attach a private-object location for an owner-uploaded original (ParsPack).
   * Replaces any existing private-object location; keeps opfs-cache when present.
   */
  attachCloudOriginal(
    actor: Actor,
    projectId: string,
    assetId: string,
    location: AssetLocationRecord & { readonly kind: 'private-object' },
  ): MediaAssetRecord | Promise<MediaAssetRecord>;
  /** Update Hermes tags / sort name / optional display name for catalog automation. */
  updateAssetMetadata(
    actor: Actor,
    projectId: string,
    assetId: string,
    patch: {
      readonly tags?: readonly string[];
      readonly sortName?: string;
      readonly displayName?: string;
    },
  ): MediaAssetRecord | Promise<MediaAssetRecord>;
  /** Owner-only hard delete, including reference-count candidates for object purge. */
  deleteAsset(
    actor: Actor,
    projectId: string,
    assetId: string,
  ): AssetDeletionResult | Promise<AssetDeletionResult>;
  assetsForProject(
    actor: Actor,
    projectId: string,
  ): readonly MediaAssetRecord[] | Promise<readonly MediaAssetRecord[]>;
  /**
   * Grant an owner project access to a durable asset from that same owner's
   * library or from the curated shared library. The asset ID stays stable so
   * existing timeline documents and Worker source maps remain valid.
   */
  associateAsset(
    actor: Actor,
    projectId: string,
    assetId: string,
  ): MediaAssetRecord | Promise<MediaAssetRecord>;
  /**
   * All assets across every project owned by this Joy identity (cross-browser catalog).
   */
  assetsForOwner(actor: Actor): readonly MediaAssetRecord[] | Promise<readonly MediaAssetRecord[]>;
  /** Curated cloud library published by the dedicated library service identity. */
  sharedCloudAssets(
    actor: Actor,
  ): readonly MediaAssetRecord[] | Promise<readonly MediaAssetRecord[]>;
  /** Resolve a cloud original only when it is curated or owned by the actor. */
  sharedCloudAsset(actor: Actor, assetId: string): MediaAssetRecord | Promise<MediaAssetRecord>;
  registerLocalDerivative(
    actor: Actor,
    projectId: string,
    derivative: LocalDerivativeRegistration,
    now?: number,
  ): MediaDerivativeRecord | Promise<MediaDerivativeRecord>;
  registerWorkerCloudDerivative(
    workerId: string,
    jobId: string,
    derivative: CloudDerivativeRegistration,
    now?: number,
    leaseToken?: string,
  ): MediaDerivativeRecord | Promise<MediaDerivativeRecord>;
  /** Resolve the exact cloud derivative for an active Worker lease/result. */
  workerCloudDerivativeForCompletion(
    workerId: string,
    jobId: string,
    receipt: WorkerResultReceipt,
    now?: number,
    leaseToken?: string,
  ): MediaDerivativeRecord | Promise<MediaDerivativeRecord>;
  derivativesForAsset(
    actor: Actor,
    projectId: string,
    assetId: string,
  ): readonly MediaDerivativeRecord[] | Promise<readonly MediaDerivativeRecord[]>;
  cloudDerivativeForOwner(
    actor: Actor,
    projectId: string,
    assetId: string,
    derivativeId: string,
  ): MediaDerivativeRecord | Promise<MediaDerivativeRecord>;
  pairWorker(actor: Actor, workerId: string): WorkerRecord | Promise<WorkerRecord>;
  createPairingOffer(
    workerId: string,
    pairingCodeHash: string,
    expiresAt: number,
  ): WorkerPairingOffer | Promise<WorkerPairingOffer>;
  approvePairing(
    actor: Actor,
    workerId: string,
    pairingCodeHash: string,
    now?: number,
  ): WorkerRecord | Promise<WorkerRecord>;
  claimWorkerSession(
    workerId: string,
    pairingCodeHash: string,
    sessionTokenHash: string,
    expiresAt: number,
    now?: number,
  ): WorkerSession | Promise<WorkerSession | undefined> | undefined;
  authenticateWorker(
    sessionTokenHash: string,
    now?: number,
  ): string | Promise<string | undefined> | undefined;
  helloWorker(
    workerId: string,
    capabilities: readonly string[],
    localAssetIds?: readonly string[],
    now?: number,
    modelInventory?: WorkerModelInventoryRecord,
  ): WorkerRecord | Promise<WorkerRecord>;
  revokeWorker(actor: Actor, workerId: string): WorkerRecord | Promise<WorkerRecord>;
  enqueue(
    actor: Actor,
    id: string,
    projectId: string,
    type: string,
    now?: number,
    assetId?: string,
    payload?: Readonly<Record<string, unknown>>,
    maxAttempts?: number,
  ): Job | Promise<Job>;
  enqueueAssetThumbnail(
    actor: Actor,
    id: string,
    projectId: string,
    assetId: string,
    now?: number,
    maxAttempts?: number,
  ): Job | Promise<Job>;
  lease(
    workerId: string,
    now?: number,
    durationMs?: number,
  ): Job | Promise<Job | undefined> | undefined;
  heartbeat(
    workerId: string,
    jobId: string,
    progress: number,
    now?: number,
    durationMs?: number,
    leaseToken?: string,
  ):
    | { readonly job: Job; readonly cancelRequested: boolean }
    | Promise<{
        readonly job: Job;
        readonly cancelRequested: boolean;
      }>;
  complete(
    workerId: string,
    jobId: string,
    now?: number,
    receipt?: WorkerResultReceipt,
    leaseToken?: string,
  ): Job | Promise<Job>;
  fail(
    workerId: string,
    jobId: string,
    error: string,
    now?: number,
    leaseToken?: string,
  ): Job | Promise<Job>;
  cancel(actor: Actor, projectId: string, jobId: string, now?: number): Job | Promise<Job>;
  retry(actor: Actor, projectId: string, jobId: string, now?: number): Job | Promise<Job>;
  jobsForProject(actor: Actor, projectId: string): readonly Job[] | Promise<readonly Job[]>;
  workersForOwner(
    actor: Actor,
    now?: number,
  ): readonly WorkerRecord[] | Promise<readonly WorkerRecord[]>;
  eventsAfter(
    actor: Actor,
    projectId: string,
    cursor: number,
  ): readonly JobEvent[] | Promise<readonly JobEvent[]>;
  readProjectDocument(
    actor: Actor,
    projectId: string,
    revisionId?: string,
  ): InternalProjectDocumentReadOutcome | Promise<InternalProjectDocumentReadOutcome>;
  writeProjectDocument(
    actor: Actor,
    record: InternalProjectDocumentRecord,
    baseRevisionId: string,
  ): InternalProjectDocumentWriteOutcome | Promise<InternalProjectDocumentWriteOutcome>;
}
export class ControlPlaneError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

/** In-memory adapter with the same revision/lease semantics as the PostgreSQL implementation. */
export class LocalControlPlane implements ControlPlane {
  readonly #projects = new Map<string, ProjectMetadata>();
  readonly #creativeBriefConsentVersions = new Map<string, string>();
  readonly #joyCodeConsentVersions = new Map<string, string>();
  readonly #workers = new Map<string, WorkerRecord>();
  readonly #jobs = new Map<string, Job>();
  readonly #jobAttempts = new Map<string, number>();
  readonly #assets = new Map<string, MediaAssetRecord>();
  /** target project + asset ID -> canonical source project ID */
  readonly #assetAccess = new Map<string, string>();
  readonly #derivatives = new Map<string, MediaDerivativeRecord>();
  readonly #events: JobEvent[] = [];
  readonly #documentStore: InternalInMemoryProjectDocumentStore;

  constructor() {
    this.#documentStore = new InternalInMemoryProjectDocumentStore((projectId) => {
      const project = this.#projects.get(projectId);
      return project?.ownerId;
    });
  }
  readonly #pairingOffers = new Map<
    string,
    { readonly pairingCodeHash: string; readonly expiresAt: number; ownerId?: string }
  >();
  readonly #workerSessions = new Map<
    string,
    { readonly workerId: string; readonly expiresAt: number }
  >();
  createProject(actor: Actor, id: string, title: string): ProjectMetadata {
    this.auth(actor);
    if (this.#projects.has(id)) throw new ControlPlaneError('PROJECT_EXISTS', id);
    const result: ProjectMetadata = {
      id,
      title,
      revision: 0,
      ownerId: actor.id,
      assetSyncEnabled: true,
      creativeBriefOptIn: false,
    };
    this.#projects.set(id, result);
    return result;
  }
  updateProject(actor: Actor, id: string, title: string, baseRevision: number): ProjectMetadata {
    const current = this.project(actor, id);
    if (current.revision !== baseRevision)
      throw new ControlPlaneError(
        'REVISION_CONFLICT',
        `expected ${baseRevision}, found ${current.revision}`,
      );
    const next = { ...current, title, revision: current.revision + 1 };
    this.#projects.set(id, next);
    return next;
  }
  getProject(actor: Actor, id: string): ProjectLifecycleMetadata {
    const project = this.projectAllowTrashed(actor, id);
    return { ...project, activeJobCount: this.activeJobCount(id) };
  }
  duplicateProject(
    actor: Actor,
    sourceId: string,
    id: string,
    title: string,
    baseRevision: number,
  ): ProjectDuplicateResult {
    const source = this.project(actor, sourceId);
    if (source.revision !== baseRevision)
      throw new ControlPlaneError(
        'REVISION_CONFLICT',
        `expected ${baseRevision}, found ${source.revision}`,
      );
    if (this.#projects.has(id)) throw new ControlPlaneError('PROJECT_EXISTS', id);
    const sourceAssets = [...this.#assets.values()].filter((asset) => asset.projectId === sourceId);
    if (
      sourceAssets.some(
        (asset) => !asset.locations.some((location) => location.kind === 'private-object'),
      )
    )
      throw new ControlPlaneError('PROJECT_MEDIA_NOT_DURABLE', sourceId);
    const result = this.createProject(actor, id, title);
    const assetIdMap: Record<string, string> = {};
    const derivativeIdMap: Record<string, string> = {};
    for (const asset of sourceAssets) {
      const nextId = randomOpaqueId('asset');
      assetIdMap[asset.id] = nextId;
      this.#assets.set(nextId, {
        ...cloneAsset(asset),
        id: nextId,
        projectId: id,
        locations: cloneLocations(
          asset.locations.filter((location) => location.kind === 'private-object'),
        ),
      });
    }
    for (const derivative of [...this.#derivatives.values()].filter(
      (item) => item.projectId === sourceId,
    )) {
      if (!derivative.locations.some((location) => location.kind === 'private-object')) continue;
      const nextId = randomOpaqueId('derivative');
      derivativeIdMap[derivative.id] = nextId;
      this.#derivatives.set(nextId, {
        ...cloneDerivative(derivative),
        id: nextId,
        projectId: id,
        assetId: assetIdMap[derivative.assetId] ?? derivative.assetId,
        locations: cloneLocations(
          derivative.locations.filter((location) => location.kind === 'private-object'),
        ),
      });
    }
    return { project: result, assetIdMap, derivativeIdMap };
  }
  trashProject(actor: Actor, id: string, baseRevision: number, now = Date.now()): ProjectMetadata {
    const current = this.project(actor, id);
    if (current.revision !== baseRevision)
      throw new ControlPlaneError(
        'REVISION_CONFLICT',
        `expected ${baseRevision}, found ${current.revision}`,
      );
    for (const [jobId, job] of this.#jobs.entries()) {
      if (job.projectId !== id) continue;
      if (job.state === 'queued') {
        this.#jobs.set(jobId, { ...job, state: 'canceled', cancelRequested: true });
        this.event(jobId, 'canceled', now);
      } else if (job.state === 'leased' && !job.cancelRequested) {
        this.#jobs.set(jobId, { ...job, cancelRequested: true });
        this.event(jobId, 'cancel-requested', now);
      }
    }
    const next = { ...current, revision: current.revision + 1, trashedAt: now };
    this.#projects.set(id, next);
    return next;
  }
  restoreProject(actor: Actor, id: string, baseRevision: number): ProjectMetadata {
    const current = this.projectAllowTrashed(actor, id);
    if (current.trashedAt === undefined) throw new ControlPlaneError('PROJECT_NOT_TRASHED', id);
    if (current.revision !== baseRevision)
      throw new ControlPlaneError(
        'REVISION_CONFLICT',
        `expected ${baseRevision}, found ${current.revision}`,
      );
    const { trashedAt, ...active } = current;
    void trashedAt;
    const next = { ...active, revision: current.revision + 1 };
    this.#projects.set(id, next);
    return next;
  }
  deleteProject(actor: Actor, id: string): ProjectDeletionResult {
    const current = this.projectAllowTrashed(actor, id);
    if (current.trashedAt === undefined) throw new ControlPlaneError('PROJECT_NOT_TRASHED', id);
    if (this.activeJobCount(id) > 0) throw new ControlPlaneError('PROJECT_BUSY', id);
    if ([...this.#assetAccess.values()].some((sourceProjectId) => sourceProjectId === id))
      throw new ControlPlaneError('PROJECT_REFERENCED', id);
    const assetIds = new Set(
      [...this.#assets.values()].filter((asset) => asset.projectId === id).map((asset) => asset.id),
    );
    const candidates = new Set<string>();
    for (const asset of [...this.#assets.values()].filter((item) => item.projectId === id)) {
      for (const ref of privateRefs(asset.locations)) candidates.add(ref);
    }
    for (const derivative of [...this.#derivatives.values()].filter(
      (item) => item.projectId === id,
    )) {
      for (const ref of privateRefs(derivative.locations)) candidates.add(ref);
    }
    for (const [jobId, job] of this.#jobs.entries()) {
      if (job.projectId === id) {
        this.#jobs.delete(jobId);
        for (const key of this.#jobAttempts.keys())
          if (key.startsWith(`${jobId}:`)) this.#jobAttempts.delete(key);
      }
    }
    for (let index = this.#events.length - 1; index >= 0; index -= 1) {
      if (!this.#jobs.has(this.#events[index]!.jobId)) this.#events.splice(index, 1);
    }
    for (const assetId of assetIds) this.#assets.delete(assetId);
    for (const [key, sourceProjectId] of this.#assetAccess.entries()) {
      const [targetProjectId] = key.split('\u0000');
      if (targetProjectId === id || sourceProjectId === id) this.#assetAccess.delete(key);
    }
    for (const [derivativeId, derivative] of this.#derivatives.entries()) {
      if (derivative.projectId === id) this.#derivatives.delete(derivativeId);
    }
    this.#projects.delete(id);
    const remaining = new Set<string>([
      ...[...this.#assets.values()].flatMap((asset) => privateRefs(asset.locations)),
      ...[...this.#derivatives.values()].flatMap((derivative) => privateRefs(derivative.locations)),
    ]);
    return { id, orphanedPrivateObjectRefs: [...candidates].filter((ref) => !remaining.has(ref)) };
  }
  setAssetSync(actor: Actor, projectId: string, enabled: boolean): ProjectMetadata {
    if (enabled !== true)
      throw new ControlPlaneError(
        'ASSET_SYNC_REQUIRED',
        'private asset backup is mandatory for JOY Media projects',
      );
    const current = this.project(actor, projectId);
    const next = { ...current, assetSyncEnabled: true };
    this.#projects.set(projectId, next);
    return next;
  }
  getCreativeBriefOptIn(actor: Actor, projectId: string): boolean {
    const project = this.project(actor, projectId);
    return (
      project.creativeBriefOptIn &&
      this.#creativeBriefConsentVersions.get(projectId) === CREATIVE_BRIEF_CONSENT_VERSION
    );
  }
  setCreativeBriefOptIn(
    actor: Actor,
    projectId: string,
    enabled: boolean,
    baseRevision: number,
  ): ProjectMetadata {
    const current = this.project(actor, projectId);
    if (current.revision !== baseRevision)
      throw new ControlPlaneError(
        'REVISION_CONFLICT',
        `expected ${baseRevision}, found ${current.revision}`,
      );
    const next = { ...current, creativeBriefOptIn: enabled, revision: current.revision + 1 };
    this.#projects.set(projectId, next);
    if (enabled) this.#creativeBriefConsentVersions.set(projectId, CREATIVE_BRIEF_CONSENT_VERSION);
    else this.#creativeBriefConsentVersions.delete(projectId);
    return next;
  }
  getJoyCodeOptIn(actor: Actor, projectId: string): JoyCodeOptInStatus {
    const project = this.project(actor, projectId);
    const consentVersion = this.#joyCodeConsentVersions.get(projectId);
    return {
      enabled: consentVersion === JOY_CODE_CONSENT_VERSION,
      ...(consentVersion === undefined ? {} : { consentVersion }),
      revision: project.revision,
    };
  }
  setJoyCodeOptIn(
    actor: Actor,
    projectId: string,
    enabled: boolean,
    consentVersion: string | undefined,
    baseRevision: number,
  ): ProjectMetadata {
    const current = this.project(actor, projectId);
    if (current.revision !== baseRevision)
      throw new ControlPlaneError(
        'REVISION_CONFLICT',
        `expected ${baseRevision}, found ${current.revision}`,
      );
    if (enabled && consentVersion !== JOY_CODE_CONSENT_VERSION)
      throw new ControlPlaneError(
        'JOY_CODE_CONSENT_VERSION_REQUIRED',
        'current disclosure version required',
      );
    const next = { ...current, revision: current.revision + 1 };
    this.#projects.set(projectId, next);
    if (enabled) this.#joyCodeConsentVersions.set(projectId, JOY_CODE_CONSENT_VERSION);
    else this.#joyCodeConsentVersions.delete(projectId);
    return next;
  }
  registerAsset(
    actor: Actor,
    projectId: string,
    asset: AssetRegistration,
    now = Date.now(),
  ): MediaAssetRecord {
    this.project(actor, projectId);
    validateAssetRegistration(asset);
    if (this.#assets.has(asset.id)) throw new ControlPlaneError('ASSET_EXISTS', asset.id);
    const record: MediaAssetRecord = {
      ...cloneAssetRegistration(asset),
      projectId,
      tags: [],
      sortName: asset.displayName.trim().toLocaleLowerCase(),
      createdAt: now,
    };
    this.#assets.set(record.id, record);
    return cloneAsset(record);
  }
  attachCloudOriginal(
    actor: Actor,
    projectId: string,
    assetId: string,
    location: AssetLocationRecord & { readonly kind: 'private-object' },
  ): MediaAssetRecord {
    this.project(actor, projectId);
    if (location.kind !== 'private-object')
      throw new ControlPlaneError('ASSET_INVALID', 'cloud original requires private-object');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(location.ref))
      throw new ControlPlaneError('ASSET_INVALID', 'asset location is invalid');
    const current = this.#assets.get(assetId);
    if (current === undefined || current.projectId !== projectId)
      throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    const kept = current.locations.filter((entry) => entry.kind !== 'private-object');
    const locations = [...kept, { kind: 'private-object' as const, ref: location.ref }];
    validateLocations(locations);
    const next: MediaAssetRecord = { ...current, locations: cloneLocations(locations) };
    this.#assets.set(assetId, next);
    return cloneAsset(next);
  }
  updateAssetMetadata(
    actor: Actor,
    projectId: string,
    assetId: string,
    patch: {
      readonly tags?: readonly string[];
      readonly sortName?: string;
      readonly displayName?: string;
    },
  ): MediaAssetRecord {
    this.project(actor, projectId);
    const current = this.#assets.get(assetId);
    if (current === undefined || current.projectId !== projectId)
      throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    const tags = patch.tags === undefined ? current.tags : validateAssetTags(patch.tags);
    const sortName =
      patch.sortName === undefined ? current.sortName : validateSortName(patch.sortName);
    const displayName =
      patch.displayName === undefined
        ? current.displayName
        : (validateDisplayName(patch.displayName), patch.displayName);
    const next: MediaAssetRecord = { ...current, tags, sortName, displayName };
    this.#assets.set(assetId, next);
    return cloneAsset(next);
  }
  deleteAsset(actor: Actor, projectId: string, assetId: string): AssetDeletionResult {
    this.project(actor, projectId);
    const current = this.#assets.get(assetId);
    if (current === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    if (current.projectId !== projectId) {
      const key = `${projectId}\u0000${assetId}`;
      if (this.#assetAccess.get(key) !== current.projectId)
        throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
      this.cancelJobsForProjectAsset(projectId, assetId);
      const candidateRefs = new Set<string>();
      for (const [derivativeId, derivative] of this.#derivatives) {
        if (derivative.projectId === projectId && derivative.assetId === assetId) {
          for (const ref of privateRefs(derivative.locations)) candidateRefs.add(ref);
          this.#derivatives.delete(derivativeId);
        }
      }
      this.#assetAccess.delete(key);
      const remainingRefs = new Set<string>([
        ...[...this.#assets.values()].flatMap((asset) => privateRefs(asset.locations)),
        ...[...this.#derivatives.values()].flatMap((derivative) =>
          privateRefs(derivative.locations),
        ),
      ]);
      return {
        id: assetId,
        orphanedPrivateObjectRefs: [...candidateRefs].filter((ref) => !remainingRefs.has(ref)),
      };
    }
    if ([...this.#assetAccess.keys()].some((key) => key.endsWith(`\u0000${assetId}`)))
      throw new ControlPlaneError('ASSET_REFERENCED', assetId);
    this.cancelJobsForProjectAsset(projectId, assetId);
    const privateObjectRefs = new Set(privateRefs(current.locations));
    for (const [derivativeId, derivative] of this.#derivatives) {
      if (derivative.assetId === assetId && derivative.projectId === projectId) {
        for (const ref of privateRefs(derivative.locations)) privateObjectRefs.add(ref);
        this.#derivatives.delete(derivativeId);
      }
    }
    this.#assets.delete(assetId);
    for (const [key] of this.#assetAccess.entries()) {
      if (key.endsWith(`\u0000${assetId}`)) this.#assetAccess.delete(key);
    }
    const remainingRefs = new Set([
      ...[...this.#assets.values()].flatMap((asset) => privateRefs(asset.locations)),
      ...[...this.#derivatives.values()].flatMap((derivative) => privateRefs(derivative.locations)),
    ]);
    return {
      id: assetId,
      orphanedPrivateObjectRefs: [...privateObjectRefs].filter((ref) => !remainingRefs.has(ref)),
    };
  }
  assetsForProject(actor: Actor, projectId: string): readonly MediaAssetRecord[] {
    this.project(actor, projectId);
    const assets = new Map(
      [...this.#assets.values()]
        .filter((asset) => asset.projectId === projectId)
        .map((asset) => [asset.id, cloneAsset(asset)] as const),
    );
    for (const [key, sourceProjectId] of this.#assetAccess.entries()) {
      const [targetProjectId, assetId] = key.split('\u0000');
      if (targetProjectId !== projectId || assetId === undefined) continue;
      const asset = this.#assets.get(assetId);
      const source = this.#projects.get(sourceProjectId);
      if (
        asset === undefined ||
        source === undefined ||
        source.trashedAt !== undefined ||
        asset.projectId !== sourceProjectId
      )
        continue;
      assets.set(asset.id, cloneAsset({ ...asset, projectId }));
    }
    return [...assets.values()];
  }
  associateAsset(actor: Actor, projectId: string, assetId: string): MediaAssetRecord {
    this.project(actor, projectId);
    const asset = this.#assets.get(assetId);
    const source = asset === undefined ? undefined : this.#projects.get(asset.projectId);
    if (asset !== undefined && asset.projectId === projectId) return cloneAsset(asset);
    if (
      asset === undefined ||
      source === undefined ||
      source.trashedAt !== undefined ||
      (source.ownerId !== actor.id && source.ownerId !== SHARED_LIBRARY_OWNER_ID) ||
      !asset.locations.some((location) => location.kind === 'private-object')
    )
      throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    this.#assetAccess.set(`${projectId}\u0000${assetId}`, asset.projectId);
    return cloneAsset({ ...asset, projectId });
  }
  assetsForOwner(actor: Actor): readonly MediaAssetRecord[] {
    this.auth(actor);
    const ownedProjectIds = new Set(
      [...this.#projects.values()]
        .filter((project) => project.ownerId === actor.id)
        .map((project) => project.id),
    );
    return [...this.#assets.values()]
      .filter((asset) => ownedProjectIds.has(asset.projectId))
      .map(cloneAsset)
      .sort(
        (left, right) =>
          left.sortName.localeCompare(right.sortName) || left.id.localeCompare(right.id),
      );
  }
  sharedCloudAssets(actor: Actor): readonly MediaAssetRecord[] {
    this.auth(actor);
    const sharedProjectIds = new Set(
      [...this.#projects.values()]
        .filter((project) => project.ownerId === SHARED_LIBRARY_OWNER_ID)
        .map((project) => project.id),
    );
    return [...this.#assets.values()]
      .filter(
        (asset) =>
          sharedProjectIds.has(asset.projectId) &&
          asset.locations.some((location) => location.kind === 'private-object'),
      )
      .map(cloneAsset)
      .sort(
        (left, right) =>
          left.sortName.localeCompare(right.sortName) || left.id.localeCompare(right.id),
      );
  }
  sharedCloudAsset(actor: Actor, assetId: string): MediaAssetRecord {
    this.auth(actor);
    const asset = this.#assets.get(assetId);
    const project = asset === undefined ? undefined : this.#projects.get(asset.projectId);
    if (
      asset === undefined ||
      project === undefined ||
      (project.ownerId !== actor.id && project.ownerId !== SHARED_LIBRARY_OWNER_ID) ||
      !asset.locations.some((location) => location.kind === 'private-object')
    ) {
      throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    }
    return cloneAsset(asset);
  }
  registerLocalDerivative(
    actor: Actor,
    projectId: string,
    derivative: LocalDerivativeRegistration,
    now = Date.now(),
  ): MediaDerivativeRecord {
    this.project(actor, projectId);
    validateLocalDerivativeRegistration(derivative);
    if (this.assetInProject(actor, projectId, derivative.assetId) === undefined)
      throw new ControlPlaneError('ASSET_NOT_FOUND', derivative.assetId);
    if (this.#derivatives.has(derivative.id))
      throw new ControlPlaneError('DERIVATIVE_EXISTS', derivative.id);
    const record: MediaDerivativeRecord = {
      ...cloneDerivativeRegistration(derivative),
      projectId,
      verifiedAt: now,
    };
    this.#derivatives.set(record.id, record);
    return cloneDerivative(record);
  }
  registerWorkerCloudDerivative(
    workerId: string,
    jobId: string,
    derivative: CloudDerivativeRegistration,
    now = Date.now(),
    leaseToken?: string,
  ): MediaDerivativeRecord {
    const job = this.ownedLease(workerId, jobId, now, leaseToken);
    // The logical derivative identity is scoped to the job generation.  A
    // manual retry must never collide with a row left by an earlier result.
    const canonicalDerivative = {
      ...derivative,
      id: workerDerivativeId(job.id, job.generation),
    };
    validateCloudDerivativeRegistration(canonicalDerivative);
    const worker = this.#workers.get(workerId);
    if (
      worker === undefined ||
      job.assetId !== canonicalDerivative.assetId ||
      derivativeKindForJob(job.type) !== canonicalDerivative.kind ||
      canonicalDerivative.availability !== 'available-cloud'
    )
      throw new ControlPlaneError('DERIVATIVE_UPLOAD_DENIED', jobId);
    const project = this.project({ id: worker.ownerId }, job.projectId);
    if (!project.assetSyncEnabled) throw new ControlPlaneError('DERIVATIVE_UPLOAD_DENIED', jobId);
    if (
      this.assetInProject({ id: worker.ownerId }, job.projectId, canonicalDerivative.assetId) ===
      undefined
    )
      throw new ControlPlaneError('ASSET_NOT_FOUND', canonicalDerivative.assetId);
    const existing = this.#derivatives.get(canonicalDerivative.id);
    if (existing !== undefined) {
      if (matchesCloudDerivativeRegistration(existing, job.projectId, canonicalDerivative))
        return cloneDerivative(existing);
      throw new ControlPlaneError('DERIVATIVE_EXISTS', canonicalDerivative.id);
    }
    const record: MediaDerivativeRecord = {
      ...cloneDerivativeRegistration(canonicalDerivative),
      projectId: job.projectId,
      verifiedAt: now,
    };
    this.#derivatives.set(record.id, record);
    return cloneDerivative(record);
  }
  workerCloudDerivativeForCompletion(
    workerId: string,
    jobId: string,
    receipt: WorkerResultReceipt,
    now = Date.now(),
    leaseToken?: string,
  ): MediaDerivativeRecord {
    const job = this.ownedLease(workerId, jobId, now, leaseToken);
    const derivative = this.#derivatives.get(workerDerivativeId(job.id, job.generation));
    if (derivative === undefined || !matchesWorkerDerivativeCompletion(derivative, job, receipt))
      throw new ControlPlaneError('DERIVATIVE_NOT_READY', jobId);
    return cloneDerivative(derivative);
  }
  derivativesForAsset(
    actor: Actor,
    projectId: string,
    assetId: string,
  ): readonly MediaDerivativeRecord[] {
    this.project(actor, projectId);
    if (this.assetInProject(actor, projectId, assetId) === undefined)
      throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    return [...this.#derivatives.values()]
      .filter((derivative) => derivative.projectId === projectId && derivative.assetId === assetId)
      .map(cloneDerivative);
  }
  cloudDerivativeForOwner(
    actor: Actor,
    projectId: string,
    assetId: string,
    derivativeId: string,
  ): MediaDerivativeRecord {
    const project = this.project(actor, projectId);
    if (!project.assetSyncEnabled) throw new ControlPlaneError('ASSET_SYNC_DISABLED', projectId);
    const derivative = this.derivativesForAsset(actor, projectId, assetId).find(
      (candidate) => candidate.id === derivativeId,
    );
    if (derivative === undefined) throw new ControlPlaneError('DERIVATIVE_NOT_FOUND', derivativeId);
    if (derivative.availability !== 'available-cloud')
      throw new ControlPlaneError('DERIVATIVE_UNAVAILABLE', derivativeId);
    if (!derivative.locations.some((location) => location.kind === 'private-object'))
      throw new ControlPlaneError('DERIVATIVE_UNAVAILABLE', derivativeId);
    return derivative;
  }
  pairWorker(actor: Actor, workerId: string): WorkerRecord {
    this.auth(actor);
    const worker = {
      id: workerId,
      ownerId: actor.id,
      paired: true,
      revoked: false,
      capabilities: [],
      localAssetIds: [],
    };
    this.#workers.set(workerId, worker);
    return worker;
  }
  createPairingOffer(
    workerId: string,
    pairingCodeHash: string,
    expiresAt: number,
  ): WorkerPairingOffer {
    if (workerId.length === 0 || pairingCodeHash.length === 0 || expiresAt <= 0)
      throw new ControlPlaneError('PAIRING_OFFER_INVALID', 'worker pairing offer is invalid');
    this.#pairingOffers.set(workerId, { pairingCodeHash, expiresAt });
    return { workerId, expiresAt };
  }
  approvePairing(
    actor: Actor,
    workerId: string,
    pairingCodeHash: string,
    now = Date.now(),
  ): WorkerRecord {
    this.auth(actor);
    const offer = this.#pairingOffers.get(workerId);
    if (offer === undefined || offer.expiresAt <= now || offer.pairingCodeHash !== pairingCodeHash)
      throw new ControlPlaneError('PAIRING_CODE_INVALID', workerId);
    this.#pairingOffers.set(workerId, { ...offer, ownerId: actor.id });
    return {
      id: workerId,
      ownerId: actor.id,
      paired: false,
      revoked: false,
      capabilities: [],
      localAssetIds: [],
    };
  }
  claimWorkerSession(
    workerId: string,
    pairingCodeHash: string,
    sessionTokenHash: string,
    expiresAt: number,
    now = Date.now(),
  ): WorkerSession | undefined {
    const offer = this.#pairingOffers.get(workerId);
    if (
      offer === undefined ||
      offer.ownerId === undefined ||
      offer.expiresAt <= now ||
      offer.pairingCodeHash !== pairingCodeHash
    )
      return undefined;
    this.#pairingOffers.delete(workerId);
    this.#workers.set(workerId, {
      id: workerId,
      ownerId: offer.ownerId,
      paired: true,
      revoked: false,
      capabilities: [],
      localAssetIds: [],
    });
    this.#workerSessions.set(sessionTokenHash, { workerId, expiresAt });
    return { workerId, expiresAt };
  }
  authenticateWorker(sessionTokenHash: string, now = Date.now()): string | undefined {
    const session = this.#workerSessions.get(sessionTokenHash);
    if (session === undefined || session.expiresAt <= now) return undefined;
    const worker = this.#workers.get(session.workerId);
    return worker === undefined || worker.revoked ? undefined : worker.id;
  }
  helloWorker(
    workerId: string,
    capabilities: readonly string[],
    localAssetIds: readonly string[] = [],
    now = Date.now(),
    modelInventory?: WorkerModelInventoryRecord,
  ): WorkerRecord {
    const worker = this.#workers.get(workerId);
    if (worker === undefined || worker.revoked)
      throw new ControlPlaneError('WORKER_UNAUTHORIZED', workerId);
    const next = {
      ...worker,
      capabilities: [...new Set(capabilities)].sort(),
      localAssetIds: validatedOpaqueIds(localAssetIds),
      lastSeenAt: now,
      ...(modelInventory === undefined ? {} : { modelInventory }),
    };
    this.#workers.set(workerId, next);
    return next;
  }
  revokeWorker(actor: Actor, workerId: string): WorkerRecord {
    const worker = this.#workers.get(workerId);
    if (worker === undefined || worker.ownerId !== actor.id)
      throw new ControlPlaneError('WORKER_NOT_FOUND', workerId);
    const revoked = { ...worker, revoked: true };
    this.#workers.set(workerId, revoked);
    return revoked;
  }
  enqueue(
    actor: Actor,
    id: string,
    projectId: string,
    type: string,
    now = Date.now(),
    assetId?: string,
    payload?: Readonly<Record<string, unknown>>,
    maxAttempts?: number,
  ): Job {
    assertSupportedWorkerJobType(type);
    this.project(actor, projectId);
    validateWorkerMaxAttempts(maxAttempts);
    if (type === 'asset.thumbnail')
      throw new ControlPlaneError(
        'ASSET_JOB_INVALID',
        'asset thumbnail requires an opaque asset ID',
      );
    if (requiresSourceAsset(type) && assetId === undefined)
      throw new ControlPlaneError('ASSET_JOB_INVALID', 'Worker generation requires an asset ID');
    if (requiresSourceAsset(type) && assetId !== undefined) {
      const asset = this.assetInProject(actor, projectId, assetId);
      if (asset === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
      if (
        (type === 'mask.image' && asset.kind !== 'image') ||
        (type === 'mask.video' && asset.kind !== 'video')
      )
        throw new ControlPlaneError('ASSET_JOB_INVALID', `${type} source kind is invalid`);
    }
    const job: Job = {
      id,
      projectId,
      type,
      ...(assetId !== undefined ? { assetId } : {}),
      ...(payload === undefined ? {} : { payload: validatedJobPayload(payload) }),
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
      generation: 0,
      state: 'queued',
      progress: 0,
      cancelRequested: false,
    };
    this.#jobs.set(id, job);
    this.event(id, 'queued', now);
    return job;
  }
  enqueueAssetThumbnail(
    actor: Actor,
    id: string,
    projectId: string,
    assetId: string,
    now = Date.now(),
    maxAttempts?: number,
  ): Job {
    this.project(actor, projectId);
    validateWorkerMaxAttempts(maxAttempts);
    if (this.assetInProject(actor, projectId, assetId) === undefined)
      throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    const job: Job = {
      id,
      projectId,
      type: 'asset.thumbnail',
      assetId,
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
      generation: 0,
      state: 'queued',
      progress: 0,
      cancelRequested: false,
    };
    this.#jobs.set(id, job);
    this.event(id, 'queued', now);
    return job;
  }
  lease(workerId: string, now = Date.now(), durationMs = 30_000): Job | undefined {
    const worker = this.#workers.get(workerId);
    if (worker === undefined || worker.revoked || !worker.paired)
      throw new ControlPlaneError('WORKER_UNAUTHORIZED', workerId);
    let job: Job | undefined;
    for (const item of this.#jobs.values()) {
      if (
        !isWorkerCompatible(worker, item) ||
        (item.state !== 'queued' &&
          !(
            item.state === 'leased' &&
            item.leaseExpiresAt !== undefined &&
            item.leaseExpiresAt <= now
          ))
      )
        continue;
      const attempts = this.#jobAttempts.get(attemptKey(item.id, item.generation)) ?? 0;
      if (item.maxAttempts !== undefined && attempts >= item.maxAttempts) {
        const terminal = terminalJobAfterAttemptBudget(item);
        this.#jobs.set(item.id, terminal);
        this.event(item.id, terminal.state, now);
        continue;
      }
      job = item;
      break;
    }
    if (job === undefined) return undefined;
    const leased: Job = {
      ...job,
      state: 'leased',
      leaseOwner: workerId,
      leaseExpiresAt: now + durationMs,
      leaseToken: randomOpaqueId('lease'),
    };
    this.#jobs.set(job.id, leased);
    this.#jobAttempts.set(
      attemptKey(job.id, job.generation),
      (this.#jobAttempts.get(attemptKey(job.id, job.generation)) ?? 0) + 1,
    );
    this.event(job.id, 'leased', now);
    return leased;
  }
  heartbeat(
    workerId: string,
    jobId: string,
    progress: number,
    now = Date.now(),
    durationMs = 30_000,
    leaseToken?: string,
  ): { readonly job: Job; readonly cancelRequested: boolean } {
    const job = this.ownedLease(workerId, jobId, now, leaseToken);
    if (!Number.isSafeInteger(progress) || progress < job.progress || progress > 100)
      throw new ControlPlaneError('PROGRESS_INVALID', jobId);
    const updated = { ...job, progress, leaseExpiresAt: now + durationMs };
    this.#jobs.set(jobId, updated);
    const worker = this.#workers.get(workerId);
    if (worker !== undefined) this.#workers.set(workerId, { ...worker, lastSeenAt: now });
    this.event(jobId, `progress:${progress}`, now);
    return { job: updated, cancelRequested: updated.cancelRequested };
  }
  complete(
    workerId: string,
    jobId: string,
    now = Date.now(),
    receipt?: WorkerResultReceipt,
    leaseToken?: string,
  ): Job {
    const job = this.ownedLease(workerId, jobId, now, leaseToken);
    if (job.cancelRequested) throw new ControlPlaneError('JOB_CANCEL_REQUESTED', jobId);
    if (job.type === 'fixture.thumbnail' && !isFixtureReceipt(receipt))
      throw new ControlPlaneError('RESULT_INVALID', jobId);
    if (
      job.type === 'asset.thumbnail' &&
      (!isAssetThumbnailReceipt(receipt) || receipt.assetId !== job.assetId)
    )
      throw new ControlPlaneError('RESULT_INVALID', jobId);
    if (
      (job.type === 'image.comfy' || job.type === 'audio.ml-denoise') &&
      (!isLocalGpuReceipt(receipt) || receipt.kind !== job.type || receipt.assetId !== job.assetId)
    )
      throw new ControlPlaneError('RESULT_INVALID', jobId);
    if (
      (job.type === 'mask.image' || job.type === 'mask.video') &&
      (!isMaskReceipt(receipt) || receipt.kind !== job.type || receipt.assetId !== job.assetId)
    )
      throw new ControlPlaneError('RESULT_INVALID', jobId);
    if (
      (job.type === 'upscale.image' || job.type === 'upscale.video') &&
      (!isUpscaleReceipt(receipt) || receipt.kind !== job.type || receipt.assetId !== job.assetId)
    )
      throw new ControlPlaneError('RESULT_INVALID', jobId);
    if (receipt !== undefined && derivativeKindForJob(job.type) !== undefined) {
      const registered = this.#derivatives.get(workerDerivativeId(job.id, job.generation));
      if (registered === undefined || !matchesWorkerDerivativeCompletion(registered, job, receipt))
        throw new ControlPlaneError('DERIVATIVE_NOT_READY', jobId);
    }
    const derivative =
      receipt === undefined
        ? undefined
        : derivativeOf(jobId, job.generation, workerId, receipt, now);
    const done: Job = {
      ...job,
      state: 'completed',
      progress: 100,
      cancelRequested: false,
      ...(derivative === undefined ? {} : { derivative }),
    };
    this.#jobs.set(jobId, done);
    this.event(jobId, 'completed', now);
    return done;
  }
  fail(workerId: string, jobId: string, error: string, now = Date.now(), leaseToken?: string): Job {
    const job = this.ownedLease(workerId, jobId, now, leaseToken);
    const canceled = error === 'canceled';
    const failed = {
      ...job,
      state: canceled ? ('canceled' as const) : ('failed' as const),
      ...(canceled ? {} : { error: error.slice(0, 500) }),
      cancelRequested: false,
    };
    this.#jobs.set(jobId, failed);
    this.event(jobId, canceled ? 'canceled' : 'failed', now);
    return failed;
  }
  cancel(actor: Actor, projectId: string, jobId: string, now = Date.now()): Job {
    this.project(actor, projectId);
    const job = this.#jobs.get(jobId);
    if (job === undefined || job.projectId !== projectId)
      throw new ControlPlaneError('JOB_NOT_FOUND', jobId);
    if (job.state === 'queued') {
      const canceled = { ...job, state: 'canceled' as const };
      this.#jobs.set(jobId, canceled);
      this.event(jobId, 'canceled', now);
      return canceled;
    }
    if (job.state !== 'leased') throw new ControlPlaneError('JOB_NOT_CANCELABLE', jobId);
    const requested = { ...job, cancelRequested: true };
    this.#jobs.set(jobId, requested);
    this.event(jobId, 'cancel-requested', now);
    return requested;
  }
  retry(actor: Actor, projectId: string, jobId: string, now = Date.now()): Job {
    this.project(actor, projectId);
    const job = this.#jobs.get(jobId);
    if (job === undefined || job.projectId !== projectId)
      throw new ControlPlaneError('JOB_NOT_FOUND', jobId);
    if (job.state === 'leased' || job.state === 'queued')
      throw new ControlPlaneError('JOB_NOT_RETRYABLE', jobId);
    const retried: Job = {
      id: job.id,
      projectId: job.projectId,
      type: job.type,
      ...(job.assetId === undefined ? {} : { assetId: job.assetId }),
      ...(job.payload === undefined ? {} : { payload: job.payload }),
      ...(job.maxAttempts === undefined ? {} : { maxAttempts: job.maxAttempts }),
      generation: job.generation + 1,
      state: 'queued',
      progress: 0,
      cancelRequested: false,
    };
    this.#jobs.set(jobId, retried);
    this.event(jobId, 'retried', now);
    return retried;
  }
  jobsForProject(actor: Actor, projectId: string): readonly Job[] {
    this.projectAllowTrashed(actor, projectId);
    return [...this.#jobs.values()].filter((job) => job.projectId === projectId);
  }
  workersForOwner(actor: Actor): readonly WorkerRecord[] {
    this.auth(actor);
    return [...this.#workers.values()].filter((worker) => worker.ownerId === actor.id);
  }
  eventsAfter(actor: Actor, projectId: string, cursor: number): readonly JobEvent[] {
    this.projectAllowTrashed(actor, projectId);
    const ids = new Set(
      [...this.#jobs.values()].filter((job) => job.projectId === projectId).map((job) => job.id),
    );
    return this.#events.filter((event) => event.cursor > cursor && ids.has(event.jobId));
  }
  readProjectDocument(
    actor: Actor,
    projectId: string,
    revisionId?: string,
  ): InternalProjectDocumentReadOutcome {
    return this.#documentStore.readDocument(actor.id, projectId, revisionId);
  }
  writeProjectDocument(
    actor: Actor,
    record: InternalProjectDocumentRecord,
    baseRevisionId: string,
  ): InternalProjectDocumentWriteOutcome {
    return this.#documentStore.writeDocument(actor.id, record, baseRevisionId);
  }
  private project(actor: Actor, id: string): ProjectMetadata {
    const project = this.projectAllowTrashed(actor, id);
    if (project.trashedAt !== undefined) throw new ControlPlaneError('PROJECT_TRASHED', id);
    return project;
  }
  private projectAllowTrashed(actor: Actor, id: string): ProjectMetadata {
    this.auth(actor);
    const project = this.#projects.get(id);
    if (project === undefined || project.ownerId !== actor.id)
      throw new ControlPlaneError('PROJECT_NOT_FOUND', id);
    return project;
  }
  private activeJobCount(projectId: string): number {
    return [...this.#jobs.values()].filter(
      (job) => job.projectId === projectId && (job.state === 'queued' || job.state === 'leased'),
    ).length;
  }
  private cancelJobsForProjectAsset(projectId: string, assetId: string, at = Date.now()): void {
    for (const [jobId, job] of this.#jobs.entries()) {
      if (job.projectId !== projectId || job.assetId !== assetId) continue;
      if (job.state === 'queued') {
        this.#jobs.set(jobId, { ...job, state: 'canceled', cancelRequested: true });
        this.event(jobId, 'canceled', at);
      } else if (job.state === 'leased' && !job.cancelRequested) {
        this.#jobs.set(jobId, { ...job, cancelRequested: true });
        this.event(jobId, 'cancel-requested', at);
      }
    }
  }
  /** Resolve a canonical asset through a project-local durable association. */
  private assetInProject(
    actor: Actor,
    projectId: string,
    assetId: string,
  ): MediaAssetRecord | undefined {
    this.project(actor, projectId);
    const asset = this.#assets.get(assetId);
    if (asset === undefined) return undefined;
    if (asset.projectId === projectId) return cloneAsset(asset);
    const sourceProjectId = this.#assetAccess.get(`${projectId}\u0000${assetId}`);
    const source = sourceProjectId === undefined ? undefined : this.#projects.get(sourceProjectId);
    if (
      sourceProjectId !== asset.projectId ||
      source === undefined ||
      source.trashedAt !== undefined ||
      (source.ownerId !== actor.id && source.ownerId !== SHARED_LIBRARY_OWNER_ID) ||
      !asset.locations.some((location) => location.kind === 'private-object')
    )
      return undefined;
    return cloneAsset({ ...asset, projectId });
  }
  private ownedLease(workerId: string, jobId: string, now: number, leaseToken?: string): Job {
    const job = this.#jobs.get(jobId);
    if (
      job === undefined ||
      job.state !== 'leased' ||
      job.leaseOwner !== workerId ||
      job.leaseExpiresAt === undefined ||
      job.leaseExpiresAt <= now ||
      job.leaseToken === undefined ||
      leaseToken !== job.leaseToken
    )
      throw new ControlPlaneError('LEASE_NOT_OWNED', jobId);
    return job;
  }
  private auth(actor: Actor): void {
    if (actor.id.length === 0)
      throw new ControlPlaneError('AUTH_REQUIRED', 'actor identity required');
  }
  private event(jobId: string, type: string, at: number): void {
    this.#events.push({ cursor: this.#events.length + 1, jobId, type, at });
  }
}

function attemptKey(jobId: string, generation: number): string {
  return `${jobId}:${generation}`;
}

function privateRefs(locations: readonly AssetLocationRecord[]): string[] {
  return locations
    .filter((location) => location.kind === 'private-object')
    .map((location) => location.ref);
}

function randomOpaqueId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${random}`;
}

function isFixtureReceipt(
  value: WorkerResultReceipt | undefined,
): value is FixtureThumbnailReceipt {
  return (
    value?.kind === 'fixture.thumbnail' &&
    value.sha256 === FIXTURE_THUMBNAIL_SHA256 &&
    value.bytes === FIXTURE_THUMBNAIL_BYTES
  );
}

function isAssetThumbnailReceipt(
  value: WorkerResultReceipt | undefined,
): value is AssetThumbnailReceipt {
  return (
    value?.kind === 'asset.thumbnail' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.assetId) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 100 &&
    /^thumb-[A-Za-z0-9._-]{1,110}$/.test(value.localRef) &&
    value.descriptor.mimeType === 'image/jpeg' &&
    Number.isSafeInteger(value.descriptor.width) &&
    value.descriptor.width > 0 &&
    Number.isSafeInteger(value.descriptor.height) &&
    value.descriptor.height > 0
  );
}

function isLocalGpuReceipt(value: WorkerResultReceipt | undefined): value is LocalGpuWorkerReceipt {
  return (
    (value?.kind === 'image.comfy' || value?.kind === 'audio.ml-denoise') &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.assetId) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    /^gpu-[A-Za-z0-9._-]{1,110}$/.test(value.localRef) &&
    typeof value.descriptor.mimeType === 'string' &&
    value.descriptor.mimeType.length > 0
  );
}

function isMaskReceipt(value: WorkerResultReceipt | undefined): value is MaskWorkerReceipt {
  const image = value?.kind === 'mask.image';
  const video = value?.kind === 'mask.video';
  return (
    (image || video) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.assetId) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    /^mask-[A-Za-z0-9._-]{1,110}$/.test(value.localRef) &&
    (image
      ? value.descriptor.mimeType === 'image/png'
      : value.descriptor.mimeType === 'video/webm') &&
    Number.isSafeInteger(value.descriptor.width) &&
    (value.descriptor.width ?? 0) > 0 &&
    Number.isSafeInteger(value.descriptor.height) &&
    (value.descriptor.height ?? 0) > 0 &&
    (!video ||
      (Number.isSafeInteger(value.descriptor.durationUs) && (value.descriptor.durationUs ?? 0) > 0))
  );
}

function isUpscaleReceipt(value: WorkerResultReceipt | undefined): value is UpscaleWorkerReceipt {
  const image = value?.kind === 'upscale.image';
  const video = value?.kind === 'upscale.video';
  return (
    (image || video) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.assetId) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    /^upscale-[A-Za-z0-9._-]{1,120}$/.test(value.localRef) &&
    typeof value.descriptor.mimeType === 'string' &&
    value.descriptor.mimeType.length > 0 &&
    Number.isSafeInteger(value.descriptor.width) &&
    (value.descriptor.width ?? 0) > 0 &&
    Number.isSafeInteger(value.descriptor.height) &&
    (value.descriptor.height ?? 0) > 0 &&
    (!video ||
      value.descriptor.mimeType === 'video/mp4' ||
      value.descriptor.mimeType === 'video/webm')
  );
}

function derivativeKindForJob(type: string): DerivativeKind | undefined {
  if (type === 'asset.thumbnail') return 'thumbnail';
  if (type === 'audio.ml-denoise') return 'audio';
  if (type === 'mask.image' || type === 'mask.video') return 'mask';
  if (type === 'upscale.image' || type === 'upscale.video') return 'upscale';
  return undefined;
}

/** Stable opaque row identity for one Worker result generation. */
export function workerDerivativeId(jobId: string, generation: number): string {
  const suffix = generation === 0 ? '' : `-g${generation}`;
  const direct = `derivative-${jobId}${suffix}`;
  if (direct.length <= 128) return direct;
  return `derivative-${createHash('sha256').update(jobId).digest('hex').slice(0, 48)}-g${generation}`;
}

export function matchesWorkerDerivativeCompletion(
  derivative: MediaDerivativeRecord,
  job: Job,
  receipt: WorkerResultReceipt,
): boolean {
  const kind = derivativeKindForJob(job.type);
  const descriptor = 'descriptor' in receipt ? receipt.descriptor : undefined;
  const durationUs =
    descriptor !== undefined && 'durationUs' in descriptor ? descriptor.durationUs : undefined;
  return (
    kind !== undefined &&
    derivative.id === workerDerivativeId(job.id, job.generation) &&
    derivative.projectId === job.projectId &&
    derivative.assetId === job.assetId &&
    derivative.kind === kind &&
    derivative.sha256 === receipt.sha256 &&
    derivative.bytes === receipt.bytes &&
    descriptor !== undefined &&
    derivative.descriptor.mimeType === descriptor.mimeType &&
    derivative.descriptor.width === descriptor.width &&
    derivative.descriptor.height === descriptor.height &&
    derivative.descriptor.durationUs === durationUs &&
    derivative.availability === 'available-cloud' &&
    derivative.locations.some((location) => location.kind === 'private-object')
  );
}

function requiresSourceAsset(type: string): boolean {
  return (
    type === 'image.comfy' ||
    type === 'audio.ml-denoise' ||
    type === 'mask.image' ||
    type === 'mask.video' ||
    type === 'upscale.image' ||
    type === 'upscale.video'
  );
}

function isWorkerCompatible(worker: WorkerRecord, job: Job): boolean {
  if (job.type === 'asset.thumbnail') {
    return (
      job.assetId !== undefined &&
      worker.capabilities.includes('asset.thumbnail') &&
      worker.localAssetIds.includes(job.assetId)
    );
  }
  if (job.type === 'image.comfy') return worker.capabilities.includes('image.comfy');
  if (job.type === 'audio.ml-denoise') return worker.capabilities.includes('audio.ml-denoise');
  if (job.type === 'mask.image' || job.type === 'mask.video') {
    return (
      job.assetId !== undefined &&
      worker.capabilities.includes(job.type) &&
      worker.localAssetIds.includes(job.assetId)
    );
  }
  if (job.type === 'upscale.image' || job.type === 'upscale.video') {
    return (
      job.assetId !== undefined &&
      worker.capabilities.includes(job.type) &&
      worker.localAssetIds.includes(job.assetId)
    );
  }
  // Fixture / unknown types: any connected Worker may lease (existing behavior).
  return true;
}

function terminalJobAfterAttemptBudget(job: Job): Job {
  const terminal: { -readonly [Key in keyof Job]: Job[Key] } = { ...job };
  terminal.state = job.cancelRequested ? 'canceled' : 'failed';
  terminal.cancelRequested = false;
  delete terminal.leaseOwner;
  delete terminal.leaseExpiresAt;
  delete terminal.leaseToken;
  if (terminal.state === 'canceled') delete terminal.error;
  else terminal.error = WORKER_ATTEMPT_BUDGET_EXHAUSTED;
  return terminal;
}

function validatedJobPayload(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ControlPlaneError('JOB_PAYLOAD_INVALID', 'job payload must be JSON serializable');
  }
  if (serialized.length > 64 * 1024)
    throw new ControlPlaneError('JOB_PAYLOAD_INVALID', 'job payload exceeds 64 KiB');
  const parsed: unknown = JSON.parse(serialized);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new ControlPlaneError('JOB_PAYLOAD_INVALID', 'job payload must be an object');
  return parsed as Readonly<Record<string, unknown>>;
}

export function validateWorkerMaxAttempts(value: number | undefined): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < 1 || value > MAX_WORKER_ATTEMPTS)
  )
    throw new ControlPlaneError(
      'JOB_PAYLOAD_INVALID',
      `maxAttempts must be an integer from 1 to ${MAX_WORKER_ATTEMPTS}`,
    );
}

function validatedOpaqueIds(values: readonly string[]): readonly string[] {
  if (
    values.length > 1_000 ||
    values.some((value) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
  ) {
    throw new ControlPlaneError('WORKER_ASSETS_INVALID', 'Worker asset IDs must be opaque');
  }
  return [...new Set(values)].sort();
}

function derivativeOf(
  jobId: string,
  generation: number,
  workerRef: string,
  receipt: WorkerResultReceipt,
  verifiedAt: number,
): DerivativeRecord {
  return {
    jobId,
    workerRef,
    resultRef:
      receipt.kind === 'fixture.thumbnail'
        ? `derivative:${jobId}`
        : workerDerivativeResultRef(jobId, generation),
    verifiedAt,
    ...receipt,
  };
}

/** Browser-safe generated-asset identity scoped to the Worker generation. */
function workerDerivativeResultRef(jobId: string, generation: number): string {
  const id = workerDerivativeId(jobId, generation);
  return `derivative:${id.slice('derivative-'.length)}`;
}

export function validateAssetRegistration(value: AssetRegistration): void {
  validateOpaqueId(value.id, 'asset id');
  validateDisplayName(value.displayName);
  if (!['video', 'audio', 'image'].includes(value.kind))
    throw new ControlPlaneError('ASSET_INVALID', 'asset kind is invalid');
  validateHashAndBytes(value.sha256, value.bytes, 'asset');
  validateDescriptor(value.descriptor);
  validateLocations(value.locations);
}

export function validateLocalDerivativeRegistration(value: LocalDerivativeRegistration): void {
  validateDerivativeRegistration(value);
  if (value.availability !== 'pending' && value.availability !== 'available-local')
    throw new ControlPlaneError('DERIVATIVE_INVALID', 'cloud derivative state is API-owned');
  if (value.availability === 'available-local') {
    if (!value.locations.some((location) => location.kind === 'opfs-cache'))
      throw new ControlPlaneError(
        'DERIVATIVE_INVALID',
        'local derivative requires an OPFS reference',
      );
  }
}

export function validateCloudDerivativeRegistration(value: CloudDerivativeRegistration): void {
  validateDerivativeRegistration(value);
  if (value.availability !== 'available-cloud')
    throw new ControlPlaneError('DERIVATIVE_INVALID', 'cloud derivative state is invalid');
  if (!value.locations.some((location) => location.kind === 'private-object'))
    throw new ControlPlaneError('DERIVATIVE_INVALID', 'cloud derivative requires a private object');
}

/** Exact retry identity for a Worker upload whose first success response was lost. */
export function matchesCloudDerivativeRegistration(
  existing: MediaDerivativeRecord,
  projectId: string,
  candidate: CloudDerivativeRegistration,
): boolean {
  return (
    existing.projectId === projectId &&
    existing.id === candidate.id &&
    existing.assetId === candidate.assetId &&
    existing.kind === candidate.kind &&
    existing.profile === candidate.profile &&
    existing.sha256 === candidate.sha256 &&
    existing.bytes === candidate.bytes &&
    existing.availability === candidate.availability &&
    existing.descriptor.mimeType === candidate.descriptor.mimeType &&
    existing.descriptor.durationUs === candidate.descriptor.durationUs &&
    existing.descriptor.width === candidate.descriptor.width &&
    existing.descriptor.height === candidate.descriptor.height &&
    existing.locations.length === candidate.locations.length &&
    existing.locations.every(
      (location, index) =>
        location.kind === candidate.locations[index]?.kind &&
        location.ref === candidate.locations[index]?.ref,
    )
  );
}

function validateDerivativeRegistration(
  value: LocalDerivativeRegistration | CloudDerivativeRegistration,
): void {
  validateOpaqueId(value.id, 'derivative id');
  validateOpaqueId(value.assetId, 'asset id');
  if (!['thumbnail', 'proxy', 'audio', 'mask', 'upscale'].includes(value.kind))
    throw new ControlPlaneError('DERIVATIVE_INVALID', 'derivative kind is invalid');
  if (value.profile.length === 0 || value.profile.length > 128 || /[\\/]/.test(value.profile))
    throw new ControlPlaneError('DERIVATIVE_INVALID', 'derivative profile is invalid');
  validateHashAndBytes(value.sha256, value.bytes, 'derivative');
  validateDescriptor(value.descriptor);
  validateLocations(value.locations);
}

function validateOpaqueId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
    throw new ControlPlaneError('ASSET_INVALID', `${label} must be an opaque identifier`);
}

function validateDisplayName(value: string): void {
  if (value.length === 0 || value.length > 255 || /[\\/]/.test(value))
    throw new ControlPlaneError('ASSET_INVALID', 'display name must not contain a path');
}

export function validateAssetTags(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length > 32)
    throw new ControlPlaneError('ASSET_INVALID', 'tags must be at most 32 tokens');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,47}$/.test(raw))
      throw new ControlPlaneError('ASSET_INVALID', 'tag token is invalid');
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

export function validateSortName(value: string): string {
  if (value.length === 0 || value.length > 255)
    throw new ControlPlaneError('ASSET_INVALID', 'sort name is invalid');
  return value;
}

function validateHashAndBytes(hash: string, bytes: number, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(bytes) || bytes < 1)
    throw new ControlPlaneError('ASSET_INVALID', `${label} hash or byte length is invalid`);
}

function validateDescriptor(value: MediaDescriptor): void {
  if (!/^(video|audio|image)\/[a-z0-9.+-]+$/.test(value.mimeType))
    throw new ControlPlaneError('ASSET_INVALID', 'media MIME type is invalid');
  for (const dimension of [value.durationUs, value.width, value.height]) {
    if (dimension !== undefined && (!Number.isSafeInteger(dimension) || dimension < 1))
      throw new ControlPlaneError('ASSET_INVALID', 'media descriptor is invalid');
  }
}

function validateLocations(value: readonly AssetLocationRecord[]): void {
  if (value.length === 0 || value.length > 2)
    throw new ControlPlaneError('ASSET_INVALID', 'one or two opaque locations are required');
  for (const location of value) {
    if (
      !['opfs-cache', 'private-object'].includes(location.kind) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(location.ref)
    ) {
      throw new ControlPlaneError('ASSET_INVALID', 'asset location is invalid');
    }
  }
  if (new Set(value.map((location) => location.kind)).size !== value.length)
    throw new ControlPlaneError('ASSET_INVALID', 'asset locations must not repeat a kind');
}

function cloneAssetRegistration(value: AssetRegistration): AssetRegistration {
  return {
    ...value,
    descriptor: { ...value.descriptor },
    locations: cloneLocations(value.locations),
  };
}

function cloneDerivativeRegistration(
  value: LocalDerivativeRegistration | CloudDerivativeRegistration,
): LocalDerivativeRegistration | CloudDerivativeRegistration {
  return {
    ...value,
    descriptor: { ...value.descriptor },
    locations: cloneLocations(value.locations),
  };
}

function cloneAsset(value: MediaAssetRecord): MediaAssetRecord {
  return {
    ...value,
    descriptor: { ...value.descriptor },
    locations: cloneLocations(value.locations),
    tags: [...value.tags],
    sortName: value.sortName,
  };
}

function cloneDerivative(value: MediaDerivativeRecord): MediaDerivativeRecord {
  return {
    ...value,
    descriptor: { ...value.descriptor },
    locations: cloneLocations(value.locations),
  };
}

function cloneLocations(value: readonly AssetLocationRecord[]): readonly AssetLocationRecord[] {
  return value.map((location) => ({ ...location }));
}
