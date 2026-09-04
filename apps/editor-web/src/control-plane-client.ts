import { DerivativeAuthorityRevokedError } from './asset-resolver.js';
import { getStoredMediaToken } from './media-session.js';
import type { GpuPreviewFrameRequest } from '@joy-media/job-protocol';
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

export const STOCK_VIDEO_CATEGORIES = [
  { id: 'business-work', label: 'Business & Work' },
  { id: 'technology', label: 'Technology' },
  { id: 'people-lifestyle', label: 'People & Lifestyle' },
  { id: 'nature', label: 'Nature' },
  { id: 'travel-places', label: 'Travel & Places' },
  { id: 'city-transport', label: 'City & Transport' },
  { id: 'food-drink', label: 'Food & Drink' },
  { id: 'abstract-backgrounds', label: 'Abstract Backgrounds' },
] as const;

export type BrowserStockVideoCategory = (typeof STOCK_VIDEO_CATEGORIES)[number]['id'];
export type BrowserStockVideoOrientation = 'portrait' | 'landscape';

/** Browser-safe stock catalog card. Rendition URLs and provider credentials stay server-side. */
export interface BrowserStockVideo {
  readonly id: string;
  readonly category: BrowserStockVideoCategory;
  readonly title: string;
  readonly provider: 'pexels' | 'pixabay';
  readonly creator: string;
  readonly sourcePageUrl: string;
  readonly durationUs: number;
  readonly width: number;
  readonly height: number;
  readonly orientation: BrowserStockVideoOrientation;
}

export interface BrowserStockVideoPage {
  readonly items: readonly BrowserStockVideo[];
  readonly counts: Readonly<Record<BrowserStockVideoCategory, number>>;
  readonly nextCursor?: string;
}

export type BrowserStockVideoImportState =
  'claimed' | 'downloading' | 'object-stored' | 'registered' | 'completed' | 'failed';

export interface BrowserStockVideoImport {
  readonly importId: string;
  readonly state: BrowserStockVideoImportState;
  /** Transitional compatibility for services that return the completed asset by ID. */
  readonly assetId?: string;
  readonly errorCode?: string;
  readonly asset?: BrowserAsset;
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

export const RESUMABLE_ORIGINAL_UPLOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;
const MAX_RESUMABLE_ORIGINAL_UPLOAD_PART_BYTES = 4 * 1024 * 1024;
const RESUMABLE_ORIGINAL_UPLOAD_POLL_INTERVAL_MS = 750;
const RESUMABLE_ORIGINAL_UPLOAD_POLL_LIMIT = 1_200;

interface BrowserOriginalUploadStatus {
  readonly sessionId: string;
  readonly state: 'uploading' | 'committing' | 'failed' | 'complete';
  readonly partSize: number;
  readonly partCount: number;
  readonly uploadedParts: readonly number[];
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
  async stockVideos(
    category: BrowserStockVideoCategory,
    query = '',
    cursor?: string,
  ): Promise<BrowserStockVideoPage> {
    const { browserStockVideoPage } = await browserProjections;
    const params = new URLSearchParams({ category });
    if (query.trim().length > 0) params.set('q', query.trim());
    if (cursor !== undefined) params.set('cursor', cursor);
    return browserStockVideoPage(
      await this.get<unknown>(`/v1/library/stock-videos?${params}`),
      category,
    );
  }
  async stockVideoPoster(catalogId: string): Promise<Blob> {
    return this.stockVideoBytes(catalogId, 'poster');
  }
  async stockVideoPreview(catalogId: string): Promise<Blob> {
    return this.stockVideoBytes(catalogId, 'preview');
  }
  async startStockVideoImport(
    projectId: string,
    catalogId: string,
  ): Promise<BrowserStockVideoImport> {
    const { browserStockVideoImport } = await browserProjections;
    return browserStockVideoImport(
      await this.post<unknown>(`/v1/projects/${encodeURIComponent(projectId)}/stock-video-import`, {
        catalogId,
      }),
    );
  }
  async stockVideoImportStatus(
    projectId: string,
    importId: string,
  ): Promise<BrowserStockVideoImport> {
    const { browserStockVideoImport } = await browserProjections;
    return browserStockVideoImport(
      await this.get<unknown>(
        `/v1/projects/${encodeURIComponent(projectId)}/stock-video-imports/${encodeURIComponent(importId)}`,
      ),
    );
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
  private async stockVideoBytes(catalogId: string, kind: 'poster' | 'preview'): Promise<Blob> {
    const token = await this.assertion();
    const response = await fetch(
      `${this.apiUrl.replace(/\/$/, '')}/v1/library/stock-videos/${encodeURIComponent(catalogId)}/${kind}`,
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      const body = await responseBody(response);
      throw requestError(body, response.status);
    }
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
    const token = this.assertion();
    if (file.size !== asset.bytes) {
      throw new Error('selected media bytes no longer match the registered asset');
    }
    if (file.size > RESUMABLE_ORIGINAL_UPLOAD_THRESHOLD_BYTES) {
      return this.uploadAssetOriginalInParts(projectId, asset, file, token, onProgress);
    }
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
  private async uploadAssetOriginalInParts(
    projectId: string,
    asset: Pick<BrowserAsset, 'id' | 'sha256' | 'bytes' | 'descriptor'>,
    file: Blob,
    token: string,
    onProgress?: (ratio: number) => void,
  ): Promise<BrowserAsset> {
    const baseUrl = `${this.apiUrl.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(asset.id)}/original/uploads`;
    const identityHeaders = {
      authorization: `Bearer ${token}`,
      'x-joy-sha256': asset.sha256,
      'x-joy-bytes': String(asset.bytes),
      'x-joy-mime-type': asset.descriptor.mimeType,
    };
    onProgress?.(0.02);
    let upload = await originalUploadStatus(
      await fetch(baseUrl, { method: 'POST', headers: identityHeaders }),
      'create',
      asset.bytes,
    );
    const sessionId = upload.sessionId;
    if (upload.state === 'uploading' || upload.state === 'failed') {
      const uploadedParts = new Set(upload.uploadedParts);
      for (let partIndex = 0; partIndex < upload.partCount; partIndex += 1) {
        if (!uploadedParts.has(partIndex)) {
          const part = file.slice(
            partIndex * upload.partSize,
            Math.min((partIndex + 1) * upload.partSize, file.size),
            asset.descriptor.mimeType,
          );
          const partSha256 = await sha256Hex(part);
          upload = await originalUploadStatus(
            await fetch(`${baseUrl}/${encodeURIComponent(sessionId)}/parts/${partIndex}`, {
              method: 'PUT',
              headers: {
                ...identityHeaders,
                'content-type': asset.descriptor.mimeType,
                'x-joy-part-sha256': partSha256,
              },
              body: part,
            }),
            'part',
            asset.bytes,
          );
          assertOriginalUploadSession(upload, sessionId);
        }
        onProgress?.(0.05 + (0.8 * (partIndex + 1)) / upload.partCount);
      }
    }
    upload = await originalUploadStatus(
      await fetch(`${baseUrl}/${encodeURIComponent(sessionId)}/complete`, {
        method: 'POST',
        headers: identityHeaders,
      }),
      'finalize',
      asset.bytes,
      202,
    );
    assertOriginalUploadSession(upload, sessionId);
    onProgress?.(0.9);
    for (let poll = 0; poll < RESUMABLE_ORIGINAL_UPLOAD_POLL_LIMIT; poll += 1) {
      const response = await fetch(`${baseUrl}/${encodeURIComponent(sessionId)}`, {
        method: 'GET',
        headers: identityHeaders,
      });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(errorMessage(body, response.status));
      if (!isRecord(body) || !isRecord(body.data)) {
        throw new Error('JOY Media API returned an invalid original-upload status');
      }
      upload = parseOriginalUploadStatus(body.data.upload, asset.bytes);
      assertOriginalUploadSession(upload, sessionId);
      if (upload.state === 'complete') {
        if (
          !isRecord(body.data.asset) ||
          body.data.asset.cloudBacked !== true ||
          body.data.asset.id !== asset.id ||
          body.data.asset.sha256 !== asset.sha256 ||
          body.data.asset.bytes !== asset.bytes ||
          !isRecord(body.data.asset.descriptor) ||
          body.data.asset.descriptor.mimeType !== asset.descriptor.mimeType
        ) {
          throw new Error('JOY Media API completed an upload without a cloud-backed asset');
        }
        onProgress?.(1);
        return body.data.asset as unknown as BrowserAsset;
      }
      if (upload.state === 'failed') {
        throw new Error('JOY Media could not finish the private cloud upload. Try again.');
      }
      onProgress?.(0.9 + Math.min(0.09, poll * 0.002));
      await wait(RESUMABLE_ORIGINAL_UPLOAD_POLL_INTERVAL_MS);
    }
    throw new Error('JOY Media is still processing the private cloud upload. Try again.');
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

  /** Authenticated remote spectral denoise used only after explicit user consent. */
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
  if (status === 408 || status === 504 || status === 524) {
    return `JOY Media request timed out (${status}). Try again.`;
  }
  if (status === 502 || status === 503 || (status >= 520 && status <= 530)) {
    return `JOY Media is temporarily unavailable (${status}). Try again shortly.`;
  }
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
    // Proxy/CDN failures can return entire HTML error pages. Non-JSON response
    // bodies are never part of the browser-facing error contract.
    return {};
  }
}

async function originalUploadStatus(
  response: Response,
  operation: 'create' | 'part' | 'finalize',
  assetBytes: number,
  expectedStatus = 200,
): Promise<BrowserOriginalUploadStatus> {
  const body = await responseBody(response);
  if (!response.ok) throw new Error(errorMessage(body, response.status));
  if (response.status !== expectedStatus || !isRecord(body) || !isRecord(body.data)) {
    throw new Error(`JOY Media API returned an invalid original-upload ${operation} response`);
  }
  return parseOriginalUploadStatus(body.data.upload, assetBytes);
}

function parseOriginalUploadStatus(
  value: unknown,
  assetBytes: number,
): BrowserOriginalUploadStatus {
  if (!isRecord(value)) throw new Error('JOY Media API returned an invalid upload status');
  const { sessionId, state, partSize, partCount, uploadedParts } = value;
  if (
    typeof sessionId !== 'string' ||
    !/^upload-[a-f0-9]{48}$/.test(sessionId) ||
    (state !== 'uploading' &&
      state !== 'committing' &&
      state !== 'failed' &&
      state !== 'complete') ||
    typeof partSize !== 'number' ||
    !Number.isSafeInteger(partSize) ||
    partSize < 1 ||
    partSize > MAX_RESUMABLE_ORIGINAL_UPLOAD_PART_BYTES ||
    typeof partCount !== 'number' ||
    !Number.isSafeInteger(partCount) ||
    partCount !== Math.ceil(assetBytes / partSize) ||
    !Array.isArray(uploadedParts) ||
    uploadedParts.some(
      (part) =>
        typeof part !== 'number' || !Number.isSafeInteger(part) || part < 0 || part >= partCount,
    ) ||
    new Set(uploadedParts).size !== uploadedParts.length
  ) {
    throw new Error('JOY Media API returned an invalid upload status');
  }
  return {
    sessionId,
    state,
    partSize,
    partCount,
    uploadedParts: uploadedParts as number[],
  };
}

function assertOriginalUploadSession(
  upload: BrowserOriginalUploadStatus,
  expectedSessionId: string,
): void {
  if (upload.sessionId !== expectedSessionId) {
    throw new Error('JOY Media API changed the active upload session');
  }
}

async function sha256Hex(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
