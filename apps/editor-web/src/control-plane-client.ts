import { DerivativeAuthorityRevokedError } from './asset-resolver.js';
import { getStoredMediaToken } from './media-session.js';
import type { GpuPreviewFrameRequest } from '@joy-media/job-protocol';
import type {
  CreativeBriefV1,
  CreativeBriefRequestV1,
  JoyCodePlanProposalV1,
} from '@joy-media/agent-tools';
import type { JoyProjectV1, ProjectRevisionId } from '@joy-media/project-schema';

const browserProjections = import('./browser-projections.js');

export interface BrowserWorker {
  readonly id: string;
  readonly paired: boolean;
  readonly revoked: boolean;
  readonly capabilities: readonly string[];
  readonly localAssetIds?: readonly string[];
  readonly lastSeenAt?: number;
  readonly modelInventory?: {
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
  };
}

export interface BrowserJob {
  readonly id: string;
  readonly projectId: string;
  readonly type: string;
  readonly assetId?: string;
  readonly state: 'queued' | 'leased' | 'completed' | 'canceled' | 'failed';
  readonly progress: number;
  readonly cancelRequested: boolean;
  readonly error?: string;
  readonly derivative?: {
    readonly id: string;
    readonly jobId: string;
    readonly kind: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly workerRef: string;
    readonly resultRef: string;
    readonly verifiedAt: number;
  };
}

/** Owner-safe catalog metadata. Locations are deliberately not exposed to the editor UI. */
export interface BrowserAsset {
  readonly id: string;
  readonly projectId: string;
  readonly kind: 'video' | 'audio' | 'image';
  readonly displayName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: BrowserMediaDescriptor;
  readonly tags?: readonly string[];
  readonly sortName?: string;
  readonly createdAt: number;
  readonly cloudBacked: boolean;
}

export interface BrowserMediaDescriptor {
  readonly mimeType: string;
  readonly durationUs?: number;
  readonly width?: number;
  readonly height?: number;
  readonly animation?: BrowserAnimationDescriptor;
}

export interface BrowserAnimationDescriptor {
  readonly frameCount: number;
  readonly cycleDurationUs: number;
  /** Zero means the source declares infinite looping. */
  readonly loopCount: number;
  readonly hasAlpha: boolean;
}

export interface BrowserDerivative {
  readonly id: string;
  readonly projectId: string;
  readonly assetId: string;
  readonly kind: 'thumbnail' | 'proxy' | 'audio' | 'mask' | 'upscale';
  readonly profile: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: BrowserMediaDescriptor;
  readonly availability: 'pending' | 'available-local' | 'available-cloud' | 'evicted' | 'invalid';
  readonly verifiedAt: number;
}

export interface BrowserReasoningProvider {
  readonly providerId: string;
  readonly state:
    'unconfigured' | 'configured' | 'healthy' | 'degraded' | 'offline' | 'unauthorized';
  readonly models: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly version?: string;
  }[];
  readonly adapterVersion: string;
}

export interface BrowserSpectralDenoiseResult {
  readonly assetId: string;
  readonly mimeType: string;
  readonly bytesBase64: string;
  readonly method: 'ffmpeg-afftdn';
  readonly strength: number;
}

export interface BrowserSpectralDenoiseOperation {
  readonly projectId: string;
  readonly operationId: string;
  readonly status: 'running' | 'succeeded' | 'failed';
  readonly result?: BrowserSpectralDenoiseResult;
  readonly error?: string;
  readonly leaseExpiresAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export class BrowserControlPlaneRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserControlPlaneRequestError';
  }
}

export interface BrowserProjectMetadata {
  readonly id: string;
  readonly title: string;
  readonly revision: number;
  readonly ownerId: string;
  readonly assetSyncEnabled: boolean;
  readonly trashedAt?: number;
  readonly activeJobCount: number;
}

/** Owner-authorized canonical document returned by the control plane. */
export interface BrowserProjectDocument {
  readonly projectId: string;
  readonly revisionId: ProjectRevisionId;
  readonly document: JoyProjectV1;
}

export interface BrowserJoyCodeOptIn {
  readonly enabled: boolean;
  readonly consentVersion?: string;
  readonly revision: number;
}
export interface BrowserJoyCodePlanRequest {
  readonly projectId: string;
  readonly snapshotRevisionId: string;
  readonly prompt: string;
  readonly creativeBrief?: CreativeBriefV1;
  readonly selection: {
    readonly clipIds: readonly string[];
    readonly objectIds?: readonly string[];
  };
}

export interface BrowserProjectDuplicateResult {
  readonly project: BrowserProjectMetadata;
  readonly assetIdMap: Readonly<Record<string, string>>;
  readonly derivativeIdMap: Readonly<Record<string, string>>;
}

export interface BrowserGpuPreviewSession {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly workerId: string;
  readonly expiresAtMs: number;
}

export interface BrowserGpuPreviewFrame {
  readonly blob: Blob;
  readonly requestId: number;
  readonly renderer: 'hardware-gpu';
  readonly quality: 'quarter' | 'half' | 'full';
  readonly width: number;
  readonly height: number;
}

export interface BrowserAssetRegistration {
  readonly id: string;
  readonly kind: BrowserAsset['kind'];
  readonly displayName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: BrowserMediaDescriptor;
  readonly locations: readonly { readonly kind: 'opfs-cache'; readonly ref: string }[];
}

// Dockview keeps several panels mounted at once and each panel creates its own
// client instance. Keep read coalescing at module scope so a status tick from
// Jobs, Audio, Mask, and Enhance shares one request even when their polling
// loops are not perfectly synchronized.
const sharedInFlightReads = new Map<string, Promise<unknown>>();
const sharedReadCache = new Map<
  string,
  { readonly promise: Promise<unknown>; readonly expiresAt: number }
>();
// Slightly exceeds the ten-second polling cadence so independently mounted
// panels cannot turn timer jitter into more than six worker reads per minute.
const WORKER_READ_CACHE_TTL_MS = 12_000;
const fetchInstanceIds = new WeakMap<typeof globalThis.fetch, number>();
let nextFetchInstanceId = 1;

/**
 * A Worker hello/pairing can be completed by a protocol client outside the
 * BrowserControlPlaneClient instance (the pairing UI and acceptance journeys
 * intentionally exercise the raw protocol).  Drop the short-lived shared
 * projection before an explicit refresh so that a newly connected Worker is
 * visible immediately instead of waiting for the cache TTL.
 */
export function invalidateWorkerReadCache(): void {
  for (const key of sharedReadCache.keys()) {
    if (key.split('\u0000')[1] === '/v1/workers') sharedReadCache.delete(key);
  }
}

function fetchInstanceId(): number {
  const current = globalThis.fetch;
  const existing = fetchInstanceIds.get(current);
  if (existing !== undefined) return existing;
  const id = nextFetchInstanceId++;
  fetchInstanceIds.set(current, id);
  return id;
}

export class BrowserControlPlaneClient {
  /**
   * Coalesce concurrent read polls made by mounted panels. Dockview can keep
   * Jobs, Audio, Enhance, and Mask mounted at the same time, so a shared
   * client must not turn one refresh tick into duplicate API requests.
   */
  constructor(
    private readonly apiUrl = '/api',
    private readonly tokenProvider: () => string | undefined = () =>
      getStoredMediaToken(window.localStorage),
  ) {}

  async workers(): Promise<readonly BrowserWorker[]> {
    return this.coalescedGet('/v1/workers', WORKER_READ_CACHE_TTL_MS);
  }
  async openGpuPreviewSession(projectId: string): Promise<BrowserGpuPreviewSession> {
    return this.post(`/v1/projects/${encodeURIComponent(projectId)}/preview-sessions`, {});
  }
  async submitGpuPreviewFrame(request: GpuPreviewFrameRequest): Promise<void> {
    await this.post(
      `/v1/preview-sessions/${encodeURIComponent(request.sessionId)}/frames`,
      request,
    );
  }
  async gpuPreviewFrame(
    sessionId: string,
    requestId: number,
    signal?: AbortSignal,
  ): Promise<BrowserGpuPreviewFrame | undefined> {
    const token = await this.assertion();
    const response = await fetch(
      `${this.apiUrl.replace(/\/$/, '')}/v1/preview-sessions/${encodeURIComponent(sessionId)}/frames/${requestId}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (response.status === 202) return undefined;
    if (!response.ok) {
      const body = await responseBody(response);
      throw requestError(body, response.status);
    }
    const renderer = response.headers.get('x-joy-preview-renderer');
    const quality = response.headers.get('x-joy-preview-quality');
    const width = Number(response.headers.get('x-joy-preview-width'));
    const height = Number(response.headers.get('x-joy-preview-height'));
    const returnedRequestId = Number(response.headers.get('x-joy-preview-request-id'));
    if (
      renderer !== 'hardware-gpu' ||
      (quality !== 'quarter' && quality !== 'half' && quality !== 'full') ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      returnedRequestId !== requestId
    )
      throw new Error('JOY Media API returned invalid GPU preview metadata');
    return {
      blob: await response.blob(),
      requestId,
      renderer,
      quality,
      width,
      height,
    };
  }
  async closeGpuPreviewSession(sessionId: string): Promise<void> {
    await this.request(`/v1/preview-sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  }
  async jobs(projectId: string): Promise<readonly BrowserJob[]> {
    const { browserJobList } = await browserProjections;
    return browserJobList(
      await this.coalescedGet<unknown>(`/v1/projects/${encodeURIComponent(projectId)}/jobs`),
    );
  }
  async assets(projectId: string): Promise<readonly BrowserAsset[]> {
    const { browserAssetList } = await browserProjections;
    return browserAssetList(
      await this.get<unknown>(`/v1/projects/${encodeURIComponent(projectId)}/assets`),
    );
  }
  /** Curated service-published cloud library visible to entitled Joy users. */
  async sharedCloudAssets(): Promise<readonly BrowserAsset[]> {
    const { browserAssetList } = await browserProjections;
    return browserAssetList(await this.get<unknown>('/v1/library/cloud-assets'));
  }
  /**
   * Assets owned by this Joy identity. Passing a project keeps the active
   * workspace focused on its own media while the unscoped catalog remains
   * available to cross-project library consumers.
   */
  async myAssets(projectId?: string): Promise<readonly BrowserAsset[]> {
    const query = projectId === undefined ? '' : `?projectId=${encodeURIComponent(projectId)}`;
    const { browserAssetList } = await browserProjections;
    return browserAssetList(await this.get<unknown>(`/v1/library/my-assets${query}`));
  }
  /** Safe catalog only: model IDs and lifecycle state, never secret references or values. */
  async reasoningProviders(): Promise<readonly BrowserReasoningProvider[]> {
    const data = await this.get<{ readonly providers: readonly BrowserReasoningProvider[] }>(
      '/v1/providers/reasoning',
    );
    return data.providers;
  }
  /** Fetch a curated original or a cloud-backed original owned by this identity. */
  async sharedCloudOriginalBytes(assetId: string): Promise<Blob> {
    const token = await this.assertion();
    const response = await fetch(
      `${this.apiUrl.replace(/\/$/, '')}/v1/library/cloud-assets/${encodeURIComponent(assetId)}/content`,
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    );
    if (response.status === 401 || response.status === 403)
      throw new DerivativeAuthorityRevokedError();
    if (!response.ok) throw new Error(`cloud original request failed (${response.status})`);
    return response.blob();
  }
  async remuxBrowserMp4(
    projectId: string,
    file: Blob,
    frameRate = 30,
    frameCount?: number,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const token = await this.assertion();
    const endpoint =
      this.apiUrl.replace(/\/$/, '') +
      '/v1/projects/' +
      encodeURIComponent(projectId) +
      '/export/remux';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'video/mp4',
        'x-joy-frame-rate': String(frameRate),
        ...(frameCount === undefined ? {} : { 'x-joy-frame-count': String(frameCount) }),
      },
      body: file,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      const body = await responseBody(response);
      throw new Error(errorMessage(body, response.status));
    }
    return response.blob();
  }

  async ensureProject(id: string, title: string): Promise<void> {
    await this.post('/v1/projects/ensure', { id, title });
  }
  async derivatives(projectId: string, assetId: string): Promise<readonly BrowserDerivative[]> {
    return this.get(
      `/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/derivatives`,
    );
  }
  async registerAsset(projectId: string, asset: BrowserAssetRegistration): Promise<BrowserAsset> {
    return this.post(`/v1/projects/${encodeURIComponent(projectId)}/assets`, asset);
  }
  /** Associate a durable library asset with the active project while keeping its stable ID. */
  async associateAsset(projectId: string, assetId: string): Promise<BrowserAsset> {
    return this.post(
      `/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/associate`,
      {},
    );
  }
  /** Owner-only hard delete with reference-counted private-object cleanup. */
  async deleteAsset(
    projectId: string,
    assetId: string,
  ): Promise<{
    readonly id: string;
    readonly cloudObjectsPurged: number;
    readonly cloudObjectPurgeFailures: number;
  }> {
    return this.request(
      `/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`,
      {
        method: 'DELETE',
      },
    );
  }
  /** Upload original media bytes to private cloud (ParsPack) and apply agent tags. */
  async uploadAssetOriginal(
    projectId: string,
    asset: Pick<BrowserAsset, 'id' | 'sha256' | 'bytes' | 'descriptor'>,
    file: Blob,
    onProgress?: (ratio: number) => void,
  ): Promise<BrowserAsset> {
    const token = await this.assertion();
    onProgress?.(0.05);
    const response = await fetch(
      `${this.apiUrl.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(asset.id)}/original`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': asset.descriptor.mimeType || file.type || 'application/octet-stream',
          'x-joy-sha256': asset.sha256,
          'x-joy-bytes': String(asset.bytes),
        },
        body: file,
      },
    );
    onProgress?.(0.9);
    const body = await responseBody(response);
    if (!response.ok) throw new Error(errorMessage(body, response.status));
    if (!isRecord(body) || !isRecord(body.data) || !isRecord(body.data.asset))
      throw new Error('JOY Media API returned an invalid original-upload response');
    onProgress?.(1);
    return body.data.asset as unknown as BrowserAsset;
  }
  /** Fetches an owner-authorized original from private object storage. */
  async originalBytes(projectId: string, assetId: string): Promise<Blob> {
    const token = await this.assertion();
    const response = await fetch(
      `${this.apiUrl.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/original`,
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    );
    if (response.status === 401 || response.status === 403)
      throw new DerivativeAuthorityRevokedError();
    if (!response.ok) throw new Error(`private original request failed (${response.status})`);
    return response.blob();
  }
  async retagAsset(projectId: string, assetId: string): Promise<BrowserAsset> {
    return this.post(
      `/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/retag`,
      {},
    );
  }
  async setAssetSync(
    projectId: string,
    enabled: boolean,
  ): Promise<{ readonly assetSyncEnabled: boolean }> {
    return this.post(`/v1/projects/${encodeURIComponent(projectId)}/asset-sync`, { enabled });
  }
  async createProject(id: string, title: string): Promise<void> {
    await this.post('/v1/projects', { id, title });
  }
  async project(id: string): Promise<BrowserProjectMetadata> {
    return this.get(`/v1/projects/${encodeURIComponent(id)}`);
  }
  async renameProject(
    id: string,
    title: string,
    baseRevision: number,
  ): Promise<BrowserProjectMetadata> {
    return this.request(`/v1/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, baseRevision }),
      headers: { 'content-type': 'application/json' },
    });
  }
  async duplicateProject(
    sourceId: string,
    id: string,
    title: string,
    baseRevision: number,
  ): Promise<BrowserProjectDuplicateResult> {
    return this.post(`/v1/projects/${encodeURIComponent(sourceId)}/duplicate`, {
      id,
      title,
      baseRevision,
    });
  }
  async trashProject(id: string, baseRevision: number): Promise<BrowserProjectMetadata> {
    return this.post(`/v1/projects/${encodeURIComponent(id)}/trash`, { baseRevision });
  }
  async restoreProject(id: string, baseRevision: number): Promise<BrowserProjectMetadata> {
    return this.post(`/v1/projects/${encodeURIComponent(id)}/restore`, { baseRevision });
  }
  async deleteProject(id: string): Promise<{
    readonly id: string;
    readonly cloudObjectsPurged: number;
    readonly cloudObjectPurgeFailures: number;
  }> {
    return this.request(`/v1/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  async syncProjectDocument(
    projectId: string,
    params: {
      readonly baseRevisionId: ProjectRevisionId;
      readonly revisionId: ProjectRevisionId;
      readonly document: JoyProjectV1;
    },
  ): Promise<{ readonly projectId: string; readonly revisionId: ProjectRevisionId }> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/document`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
  }
  async projectDocument(
    projectId: string,
    revisionId?: ProjectRevisionId,
  ): Promise<BrowserProjectDocument | undefined> {
    const query =
      revisionId === undefined
        ? '?allowMissing=true'
        : `?revisionId=${encodeURIComponent(revisionId)}`;
    const document = await this.get<BrowserProjectDocument | null>(
      `/v1/projects/${encodeURIComponent(projectId)}/document${query}`,
    );
    return document ?? undefined;
  }
  async enqueueAssetThumbnail(projectId: string, id: string, assetId: string): Promise<BrowserJob> {
    return this.post(`/v1/projects/${encodeURIComponent(projectId)}/jobs`, {
      id,
      type: 'asset.thumbnail',
      assetId,
    });
  }
  /** Queues a local-GPU Comfy RemBG job when a Worker advertises `image.comfy`. */
  async enqueueComfyRemoveBg(projectId: string, id: string, assetId: string): Promise<BrowserJob> {
    return this.enqueueWorkerGeneration(projectId, id, 'image.comfy', assetId);
  }
  async enqueueWorkerGeneration(
    projectId: string,
    id: string,
    type:
      | 'image.comfy'
      | 'upscale.image'
      | 'upscale.video'
      | 'mask.image'
      | 'mask.video'
      | 'audio.ml-denoise'
      | 'text.lm-studio'
      | 'text.openrouter'
      | 'video.runway'
      | 'edit.higgsfield',
    assetId: string,
    payload?: Readonly<Record<string, unknown>>,
  ): Promise<BrowserJob> {
    return this.post(`/v1/projects/${encodeURIComponent(projectId)}/jobs`, {
      id,
      type,
      assetId,
      ...(payload === undefined ? {} : { payload }),
    });
  }
  async enqueueRenderExport(
    projectId: string,
    id: string,
    assetId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<BrowserJob> {
    return this.post(`/v1/projects/${encodeURIComponent(projectId)}/jobs`, {
      id,
      type: 'render.export',
      assetId,
      payload,
    });
  }
  async enqueueMask(
    projectId: string,
    id: string,
    type: 'mask.image' | 'mask.video',
    assetId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<BrowserJob> {
    return this.enqueueWorkerGeneration(projectId, id, type, assetId, payload);
  }
  async enqueueUpscale(
    projectId: string,
    id: string,
    type: 'upscale.image' | 'upscale.video',
    assetId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<BrowserJob> {
    return this.enqueueWorkerGeneration(projectId, id, type, assetId, payload);
  }
  async enqueueAiGeneration(
    projectId: string,
    id: string,
    type:
      | 'image.comfy'
      | 'audio.ml-denoise'
      | 'text.lm-studio'
      | 'text.openrouter'
      | 'video.runway'
      | 'edit.higgsfield',
    prompt: string,
    options?: {
      readonly imageAssetId?: string;
      readonly model?: string;
      readonly params?: Record<string, unknown>;
    },
  ): Promise<BrowserJob> {
    return this.post(`/v1/projects/${encodeURIComponent(projectId)}/jobs`, {
      id,
      type,
      prompt,
      ...(options?.imageAssetId !== undefined ? { assetId: options.imageAssetId } : {}),
      ...(options?.model !== undefined ? { model: options.model } : {}),
      ...(options?.params !== undefined ? { params: options.params } : {}),
    });
  }
  async createCreativeBrief(
    controlPlaneProjectId: string,
    request: CreativeBriefRequestV1,
  ): Promise<CreativeBriefV1> {
    return this.post(`/v1/projects/${encodeURIComponent(controlPlaneProjectId)}/creative-brief`, {
      projectId: request.projectId,
      snapshotRevisionId: request.snapshotRevisionId,
      request,
    });
  }
  async setCreativeBriefOptIn(
    projectId: string,
    enabled: boolean,
    baseRevision: number,
  ): Promise<{ readonly creativeBriefOptIn: boolean; readonly revision: number }> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/creative-brief-opt-in`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled, baseRevision }),
    });
  }
  async getCreativeBriefOptIn(
    projectId: string,
  ): Promise<{ readonly creativeBriefOptIn: boolean; readonly revision: number }> {
    return this.get(`/v1/projects/${encodeURIComponent(projectId)}/creative-brief-opt-in`);
  }
  async getJoyCodeOptIn(projectId: string): Promise<BrowserJoyCodeOptIn> {
    return this.get(`/v1/projects/${encodeURIComponent(projectId)}/joy-code-opt-in`);
  }
  async setJoyCodeOptIn(
    projectId: string,
    enabled: boolean,
    consentVersion: string | null,
    baseRevision: number,
  ): Promise<BrowserJoyCodeOptIn> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/joy-code-opt-in`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled, consentVersion, baseRevision }),
    });
  }
  async createJoyCodePlan(
    controlPlaneProjectId: string,
    request: BrowserJoyCodePlanRequest,
    signal?: AbortSignal,
  ): Promise<JoyCodePlanProposalV1> {
    return this.request(
      `/v1/projects/${encodeURIComponent(controlPlaneProjectId)}/joy-code/plans`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }
  async pairWorker(workerId: string, pairingCode: string): Promise<BrowserWorker> {
    return this.post(`/v1/workers/${encodeURIComponent(workerId)}/pair`, { pairingCode });
  }
  async revokeWorker(workerId: string): Promise<BrowserWorker> {
    return this.post(`/v1/workers/${encodeURIComponent(workerId)}/revoke`, {});
  }
  async cancel(projectId: string, jobId: string): Promise<BrowserJob> {
    return this.post(
      `/v1/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/cancel`,
      {},
    );
  }
  async retry(projectId: string, jobId: string): Promise<BrowserJob> {
    return this.post(
      `/v1/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/retry`,
      {},
    );
  }
  /** Fetches private derivative bytes only from the authenticated Media API. */
  async derivativeBytes(projectId: string, assetId: string, derivativeId: string): Promise<Blob> {
    const token = await this.assertion();
    const response = await fetch(
      `${this.apiUrl.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/derivatives/${encodeURIComponent(derivativeId)}/content`,
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    );
    if (response.status === 401 || response.status === 403)
      throw new DerivativeAuthorityRevokedError();
    if (!response.ok) throw new Error(`private derivative request failed (${response.status})`);
    return response.blob();
  }

  /** Live faster-whisper transcription (authenticated). Falls back is caller's job. */
  async transcribeSpeech(
    language: string,
    options: {
      readonly referenceAssetId?: string;
      readonly media?: Blob;
      readonly mediaType?: string;
    } = {},
  ): Promise<{
    readonly language: string;
    readonly words: readonly {
      readonly text: string;
      readonly startUs: number;
      readonly endUs: number;
      readonly confidence?: number;
      readonly speakerId?: string;
    }[];
    readonly speakers: readonly { readonly id: string; readonly name: string }[];
    readonly provenance: {
      readonly providerId: string;
      readonly modelId: string;
      readonly createdAt: string;
    };
  }> {
    if (options.referenceAssetId !== undefined) {
      return this.post('/v1/providers/speech/transcribe', {
        language,
        referenceAssetId: options.referenceAssetId,
      });
    }
    if (options.media === undefined) {
      throw new Error('transcribeSpeech requires referenceAssetId or media');
    }
    const token = await this.assertion();
    const response = await fetch(
      `${this.apiUrl.replace(/\/$/, '')}/v1/providers/speech/transcribe?language=${encodeURIComponent(language)}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': options.mediaType ?? (options.media.type || 'application/octet-stream'),
        },
        body: options.media,
      },
    );
    const body = await responseBody(response);
    if (!response.ok) throw new Error(errorMessage(body, response.status));
    if (!isRecord(body) || !('data' in body))
      throw new Error('JOY Media API returned an invalid response');
    return body.data as {
      readonly language: string;
      readonly words: readonly {
        readonly text: string;
        readonly startUs: number;
        readonly endUs: number;
        readonly confidence?: number;
        readonly speakerId?: string;
      }[];
      readonly speakers: readonly { readonly id: string; readonly name: string }[];
      readonly provenance: {
        readonly providerId: string;
        readonly modelId: string;
        readonly createdAt: string;
      };
    };
  }

  async synthesizeSpeech(input: {
    readonly text: string;
    readonly language?: string;
    readonly voiceId?: string;
    readonly speed?: number;
  }): Promise<{
    readonly assetId: string;
    readonly mimeType: string;
    readonly bytesBase64: string;
    readonly voiceId: string;
    readonly engine: string;
    readonly modelId: string;
    readonly dataLeavesDevice: true;
    readonly retentionDisclosure: string;
    readonly durationUs: number;
  }> {
    return this.post('/v1/providers/speech/synthesize', input);
  }

  /** Authenticated VPS spectral denoise used only after explicit Cloud Brain consent. */
  async denoiseAudio(input: {
    readonly projectId: string;
    readonly operationId: string;
    readonly assetId: string;
    readonly media: Blob;
    readonly sampleRate?: number;
    readonly strength?: number;
  }): Promise<BrowserSpectralDenoiseResult> {
    return this.post('/v1/providers/audio/denoise', {
      projectId: input.projectId,
      operationId: input.operationId,
      assetId: input.assetId,
      mediaBase64: await blobToBase64(input.media),
      ...(input.sampleRate === undefined ? {} : { sampleRate: input.sampleRate }),
      ...(input.strength === undefined ? {} : { strength: input.strength }),
    });
  }

  /** Recovers a durable accepted/running Cloud denoise operation without re-submitting media. */
  async denoiseAudioOperation(
    projectId: string,
    operationId: string,
  ): Promise<BrowserSpectralDenoiseOperation | undefined> {
    const query = new URLSearchParams({ projectId, operationId });
    try {
      return await this.get(`/v1/providers/audio/denoise?${query.toString()}`);
    } catch (error) {
      if (
        error instanceof BrowserControlPlaneRequestError &&
        error.code === 'PROVIDER_OPERATION_NOT_FOUND'
      )
        return undefined;
      throw error;
    }
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }
  private async coalescedGet<T>(path: string, cacheTtlMs = 0): Promise<T> {
    const token = this.assertion();
    const key = `${this.apiUrl.replace(/\/$/, '')}\u0000${path}\u0000${token}\u0000${fetchInstanceId()}`;
    const existing = sharedInFlightReads.get(key);
    if (existing !== undefined) return (await existing) as T;
    if (cacheTtlMs > 0) {
      const cached = sharedReadCache.get(key);
      if (cached !== undefined) {
        if (cached.expiresAt > Date.now()) return (await cached.promise) as T;
        sharedReadCache.delete(key);
      }
    }

    const request = this.requestWithToken<T>(path, { method: 'GET' }, token);
    sharedInFlightReads.set(key, request);
    if (cacheTtlMs > 0) {
      sharedReadCache.set(key, { promise: request, expiresAt: Date.now() + cacheTtlMs });
      request.catch(() => {
        const cached = sharedReadCache.get(key);
        if (cached?.promise === request) sharedReadCache.delete(key);
      });
    }
    try {
      return await request;
    } finally {
      if (sharedInFlightReads.get(key) === request) sharedInFlightReads.delete(key);
    }
  }
  private async post<T>(path: string, body: object): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    return this.requestWithToken(path, init, this.assertion());
  }
  private async requestWithToken<T>(path: string, init: RequestInit, token: string): Promise<T> {
    const response = await fetch(`${this.apiUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}` },
    });
    const body = await responseBody(response);
    if (!response.ok) throw requestError(body, response.status);
    if (!isRecord(body) || !('data' in body))
      throw new Error('JOY Media API returned an invalid response');
    return body.data as T;
  }
  private assertion(): string {
    const token = this.tokenProvider();
    if (token === undefined) throw new Error('JOY Media session required');
    return token;
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function errorMessage(body: unknown, status: number): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
    const code = typeof body.error.code === 'string' ? `${body.error.code}: ` : '';
    return `${code}${body.error.message}`;
  }
  if (isRecord(body) && typeof body.error === 'string') return body.error;
  return `JOY Media request failed (${status})`;
}
function requestError(body: unknown, status: number): BrowserControlPlaneRequestError {
  const code =
    isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string'
      ? body.error.code
      : undefined;
  return new BrowserControlPlaneRequestError(status, code, errorMessage(body, status));
}
async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text };
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
