export interface Actor {
  readonly id: string;
}

/** Only this service identity may publish cross-account library media. */
export const SHARED_LIBRARY_OWNER_ID = 'joy-media-library';

export interface ProjectMetadata {
  readonly id: string;
  readonly title: string;
  readonly revision: number;
  readonly ownerId: string;
  /** Always true: originals and eligible derivatives use private durable storage. */
  readonly assetSyncEnabled: boolean;
}
export type MediaAssetKind = 'video' | 'audio' | 'image';
export type DerivativeKind = 'thumbnail' | 'proxy';
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
  readonly state: 'queued' | 'leased' | 'completed' | 'canceled' | 'failed';
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: number;
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
  };
}
export type WorkerResultReceipt =
  FixtureThumbnailReceipt | AssetThumbnailReceipt | LocalGpuWorkerReceipt;
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
  setAssetSync(
    actor: Actor,
    projectId: string,
    enabled: boolean,
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
  ): WorkerRecord | Promise<WorkerRecord>;
  revokeWorker(actor: Actor, workerId: string): WorkerRecord | Promise<WorkerRecord>;
  enqueue(
    actor: Actor,
    id: string,
    projectId: string,
    type: string,
    now?: number,
    assetId?: string,
  ): Job | Promise<Job>;
  enqueueAssetThumbnail(
    actor: Actor,
    id: string,
    projectId: string,
    assetId: string,
    now?: number,
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
  ): Job | Promise<Job>;
  fail(workerId: string, jobId: string, error: string, now?: number): Job | Promise<Job>;
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
  readonly #workers = new Map<string, WorkerRecord>();
  readonly #jobs = new Map<string, Job>();
  readonly #assets = new Map<string, MediaAssetRecord>();
  readonly #derivatives = new Map<string, MediaDerivativeRecord>();
  readonly #events: JobEvent[] = [];
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
    const result = { id, title, revision: 0, ownerId: actor.id, assetSyncEnabled: true };
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
    if (current === undefined || current.projectId !== projectId)
      throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    const privateObjectRefs = new Set(privateRefs(current.locations));
    for (const [derivativeId, derivative] of this.#derivatives) {
      if (derivative.projectId === projectId && derivative.assetId === assetId) {
        for (const ref of privateRefs(derivative.locations)) privateObjectRefs.add(ref);
        this.#derivatives.delete(derivativeId);
      }
    }
    this.#assets.delete(assetId);
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
    return [...this.#assets.values()]
      .filter((asset) => asset.projectId === projectId)
      .map(cloneAsset);
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
    const asset = this.#assets.get(derivative.assetId);
    if (asset === undefined || asset.projectId !== projectId)
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
  ): MediaDerivativeRecord {
    validateCloudDerivativeRegistration(derivative);
    const job = this.ownedLease(workerId, jobId, now);
    const worker = this.#workers.get(workerId);
    if (
      worker === undefined ||
      job.assetId !== derivative.assetId ||
      derivative.availability !== 'available-cloud'
    )
      throw new ControlPlaneError('DERIVATIVE_UPLOAD_DENIED', jobId);
    const project = this.project({ id: worker.ownerId }, job.projectId);
    if (!project.assetSyncEnabled) throw new ControlPlaneError('DERIVATIVE_UPLOAD_DENIED', jobId);
    const asset = this.#assets.get(derivative.assetId);
    if (asset === undefined || asset.projectId !== job.projectId)
      throw new ControlPlaneError('ASSET_NOT_FOUND', derivative.assetId);
    if (this.#derivatives.has(derivative.id))
      throw new ControlPlaneError('DERIVATIVE_EXISTS', derivative.id);
    const record: MediaDerivativeRecord = {
      ...cloneDerivativeRegistration(derivative),
      projectId: job.projectId,
      verifiedAt: now,
    };
    this.#derivatives.set(record.id, record);
    return cloneDerivative(record);
  }
  derivativesForAsset(
    actor: Actor,
    projectId: string,
    assetId: string,
  ): readonly MediaDerivativeRecord[] {
    this.project(actor, projectId);
    const asset = this.#assets.get(assetId);
    if (asset === undefined || asset.projectId !== projectId)
      throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    return [...this.#derivatives.values()]
      .filter((derivative) => derivative.assetId === assetId)
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
  ): WorkerRecord {
    const worker = this.#workers.get(workerId);
    if (worker === undefined || worker.revoked)
      throw new ControlPlaneError('WORKER_UNAUTHORIZED', workerId);
    const next = {
      ...worker,
      capabilities: [...new Set(capabilities)].sort(),
      localAssetIds: validatedOpaqueIds(localAssetIds),
      lastSeenAt: now,
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
  ): Job {
    this.project(actor, projectId);
    if (type === 'asset.thumbnail')
      throw new ControlPlaneError(
        'ASSET_JOB_INVALID',
        'asset thumbnail requires an opaque asset ID',
      );
    if ((type === 'image.comfy' || type === 'audio.ml-denoise') && assetId === undefined)
      throw new ControlPlaneError('ASSET_JOB_INVALID', 'Worker generation requires an asset ID');
    if ((type === 'image.comfy' || type === 'audio.ml-denoise') && assetId !== undefined) {
      const asset = this.#assets.get(assetId);
      if (asset === undefined || asset.projectId !== projectId)
        throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    }
    const job: Job = {
      id,
      projectId,
      type,
      ...(assetId !== undefined ? { assetId } : {}),
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
  ): Job {
    this.project(actor, projectId);
    const asset = this.#assets.get(assetId);
    if (asset === undefined || asset.projectId !== projectId)
      throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    const job: Job = {
      id,
      projectId,
      type: 'asset.thumbnail',
      assetId,
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
    const job = [...this.#jobs.values()].find(
      (item) =>
        isWorkerCompatible(worker, item) &&
        (item.state === 'queued' ||
          (item.state === 'leased' &&
            item.leaseExpiresAt !== undefined &&
            item.leaseExpiresAt <= now)),
    );
    if (job === undefined) return undefined;
    const leased: Job = {
      ...job,
      state: 'leased',
      leaseOwner: workerId,
      leaseExpiresAt: now + durationMs,
    };
    this.#jobs.set(job.id, leased);
    this.event(job.id, 'leased', now);
    return leased;
  }
  heartbeat(
    workerId: string,
    jobId: string,
    progress: number,
    now = Date.now(),
    durationMs = 30_000,
  ): { readonly job: Job; readonly cancelRequested: boolean } {
    const job = this.ownedLease(workerId, jobId, now);
    if (!Number.isSafeInteger(progress) || progress < job.progress || progress > 100)
      throw new ControlPlaneError('PROGRESS_INVALID', jobId);
    const updated = { ...job, progress, leaseExpiresAt: now + durationMs };
    this.#jobs.set(jobId, updated);
    const worker = this.#workers.get(workerId);
    if (worker !== undefined) this.#workers.set(workerId, { ...worker, lastSeenAt: now });
    this.event(jobId, `progress:${progress}`, now);
    return { job: updated, cancelRequested: updated.cancelRequested };
  }
  complete(workerId: string, jobId: string, now = Date.now(), receipt?: WorkerResultReceipt): Job {
    const job = this.ownedLease(workerId, jobId, now);
    if (job.type === 'fixture.thumbnail' && !isFixtureReceipt(receipt))
      throw new ControlPlaneError('RESULT_INVALID', jobId);
    if (
      job.type === 'asset.thumbnail' &&
      (!isAssetThumbnailReceipt(receipt) || receipt.assetId !== job.assetId)
    )
      throw new ControlPlaneError('RESULT_INVALID', jobId);
    if (
      (job.type === 'image.comfy' || job.type === 'audio.ml-denoise') &&
      (!isLocalGpuReceipt(receipt) || receipt.kind !== job.type)
    )
      throw new ControlPlaneError('RESULT_INVALID', jobId);
    const derivative =
      receipt === undefined ? undefined : derivativeOf(jobId, workerId, receipt, now);
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
  fail(workerId: string, jobId: string, error: string, now = Date.now()): Job {
    const job = this.ownedLease(workerId, jobId, now);
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
      state: 'queued',
      progress: 0,
      cancelRequested: false,
    };
    this.#jobs.set(jobId, retried);
    this.event(jobId, 'retried', now);
    return retried;
  }
  jobsForProject(actor: Actor, projectId: string): readonly Job[] {
    this.project(actor, projectId);
    return [...this.#jobs.values()].filter((job) => job.projectId === projectId);
  }
  workersForOwner(actor: Actor): readonly WorkerRecord[] {
    this.auth(actor);
    return [...this.#workers.values()].filter((worker) => worker.ownerId === actor.id);
  }
  eventsAfter(actor: Actor, projectId: string, cursor: number): readonly JobEvent[] {
    this.project(actor, projectId);
    const ids = new Set(
      [...this.#jobs.values()].filter((job) => job.projectId === projectId).map((job) => job.id),
    );
    return this.#events.filter((event) => event.cursor > cursor && ids.has(event.jobId));
  }
  private project(actor: Actor, id: string): ProjectMetadata {
    this.auth(actor);
    const project = this.#projects.get(id);
    if (project === undefined || project.ownerId !== actor.id)
      throw new ControlPlaneError('PROJECT_NOT_FOUND', id);
    return project;
  }
  private ownedLease(workerId: string, jobId: string, now: number): Job {
    const job = this.#jobs.get(jobId);
    if (
      job === undefined ||
      job.state !== 'leased' ||
      job.leaseOwner !== workerId ||
      job.leaseExpiresAt === undefined ||
      job.leaseExpiresAt <= now
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

function privateRefs(locations: readonly AssetLocationRecord[]): string[] {
  return locations
    .filter((location) => location.kind === 'private-object')
    .map((location) => location.ref);
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
  // Fixture / unknown types: any connected Worker may lease (existing behavior).
  return true;
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
  workerRef: string,
  receipt: WorkerResultReceipt,
  verifiedAt: number,
): DerivativeRecord {
  return {
    jobId,
    workerRef,
    resultRef: `derivative:${jobId}`,
    verifiedAt,
    ...receipt,
  };
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

function validateDerivativeRegistration(
  value: LocalDerivativeRegistration | CloudDerivativeRegistration,
): void {
  validateOpaqueId(value.id, 'derivative id');
  validateOpaqueId(value.assetId, 'asset id');
  if (!['thumbnail', 'proxy'].includes(value.kind))
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
