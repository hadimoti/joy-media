import {
  WORKER_PROTOCOL_VERSION,
  type RenderJobPayload,
  type RenderInspectPayload,
  type VideoReferenceAnalyzePayload,
} from '@joy-media/job-protocol';
import type {
  ProductionRunAuthority,
  ProductionRunCheckpointUpdateResultV1,
  ProductionRunCheckpointUpdateV1,
  ProductionRunRecordV1,
  RecordProductionApprovalResponseInput,
  RecordProductionApprovalResponseResult,
} from '@joy-media/workflow-engine';
import type {
  CapabilityId,
  Money,
  ProviderApprovalGrant,
  ProviderApprovalPreflight,
} from '@joy-media/provider-sdk';
import { validateProjectDocumentV2, type ProjectDocumentV2 } from '@joy-media/project-schema';
import { DerivativeAuthorityRevokedError } from './asset-resolver.js';
import { getStoredMediaToken } from './media-session.js';
import { BrowserControlPlaneError } from './control-plane-errors.js';
export { BrowserControlPlaneError } from './control-plane-errors.js';

export interface BrowserWorker {
  readonly id: string;
  readonly paired: boolean;
  readonly revoked: boolean;
  readonly capabilities: readonly string[];
  readonly lastSeenAt?: number;
}

export interface BrowserProject {
  readonly id: string;
  readonly title: string;
  readonly revision: number;
  readonly ownerId: string;
  readonly assetSyncEnabled: boolean;
}

export interface BrowserProjectDocumentSnapshot {
  readonly projectId: string;
  readonly revision: number;
  readonly document: ProjectDocumentV2;
  readonly documentHash: string;
  readonly updatedAt: string;
}

export interface BrowserProjectRevision {
  readonly projectId: string;
  readonly revision: number;
  readonly baseRevision: number;
  readonly idempotencyKey: string;
  readonly operation: {
    readonly kind: 'replace' | 'restore';
    readonly idempotencyKey: string;
    readonly label?: string;
    readonly targetRevision?: number;
  };
  readonly document: ProjectDocumentV2;
  readonly documentHash: string;
  readonly createdAt: string;
}

export type BrowserRecoveredCopyOperation =
  | {
      readonly kind: 'append';
      readonly document: ProjectDocumentV2;
      readonly label?: string;
    }
  | {
      readonly kind: 'restore';
      readonly targetRevision: number;
      readonly label?: string;
    };

export interface BrowserProjectRecoveredCopy {
  readonly kind: 'recovered-copy';
  readonly projectId: string;
  readonly name: string;
  readonly document: ProjectDocumentV2;
  readonly basedOnRevision: number;
  readonly serverRevision: number;
  readonly createdAt: string;
  readonly provenance: {
    readonly sourceProjectId: string;
    readonly baseRevision: number;
    readonly sourceHeadRevision: number;
    readonly operation: BrowserRecoveredCopyOperation;
    readonly requestedDocumentHash: string;
  };
}

export interface BrowserProjectRecoveredCopyInput {
  readonly baseRevision: number;
  readonly idempotencyKey: string;
  readonly suggestedName: string;
  readonly operation: BrowserRecoveredCopyOperation;
}

export interface BrowserJob {
  readonly id: string;
  readonly projectId: string;
  readonly type: string;
  readonly assetId?: string;
  readonly payload?: Partial<RenderJobPayload> & Record<string, unknown>;
  readonly state: 'queued' | 'leased' | 'completed' | 'canceled' | 'failed';
  readonly progress: number;
  readonly cancelRequested: boolean;
  readonly error?: string;
  readonly derivative?: {
    readonly jobId: string;
    readonly kind: string;
    readonly assetId?: string;
    readonly reportRef?: string;
    readonly outputRef?: string;
    readonly findings?: number | readonly unknown[];
    readonly qualityReport?: BrowserRenderReport;
    readonly report?: BrowserRenderReport;
    readonly sha256?: string;
    readonly bytes?: number;
    readonly descriptor?: {
      readonly mimeType: string;
      readonly width?: number;
      readonly height?: number;
      readonly durationUs?: number;
    };
    readonly summary?: {
      readonly shotCount: number;
      readonly cutCount: number;
      readonly averageShotDurationUs: number;
      readonly fastestShotDurationUs: number;
      readonly sampleCount: number;
      readonly transcriptSegmentCount: number;
      readonly audioBeatCount: number;
    };
    readonly evidence?: readonly unknown[];
    readonly evidenceIds?: readonly string[];
    readonly workerRef: string;
    readonly resultRef: string;
    readonly verifiedAt: number;
    readonly model?: string;
  };
}

export interface BrowserRenderReport {
  readonly version?: number;
  readonly evidenceLevel?: 'sampled';
  readonly findings: readonly {
    readonly status: 'pass' | 'warn' | 'fail';
  }[];
  readonly artifact?: {
    readonly outputRef: string;
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly facts?: unknown;
  readonly checkedAt?: string;
  readonly promiseId?: string;
}

/** Owner-safe catalog metadata. Locations are deliberately not exposed to the editor UI. */
export interface BrowserAsset {
  readonly id: string;
  readonly projectId: string;
  readonly kind: 'video' | 'audio' | 'image' | 'model';
  readonly displayName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: BrowserMediaDescriptor;
  readonly tags?: readonly string[];
  readonly sortName?: string;
  readonly createdAt: number;
}

export interface BrowserMediaDescriptor {
  readonly mimeType: string;
  readonly durationUs?: number;
  readonly width?: number;
  readonly height?: number;
}

/**
 * Source media for authenticated speech transcription. The current HTTP API
 * accepts either a server reference or raw media bytes. Source ranges are
 * intentionally retained here for callers and are applied by the caption
 * adapter after transcription; the server does not claim to trim media.
 */
export interface BrowserSpeechTranscriptionOptions {
  readonly referenceAssetId?: string;
  readonly media?: Blob;
  readonly mediaType?: string;
  readonly sourceStartUs?: number;
  readonly sourceDurationUs?: number;
}

export interface BrowserDerivative {
  readonly id: string;
  readonly projectId: string;
  readonly assetId: string;
  readonly kind: 'thumbnail' | 'proxy';
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

export type BrowserProviderApprovalPreflight = ProviderApprovalPreflight;
export type BrowserProviderApprovalGrant = ProviderApprovalGrant;

export interface BrowserJoyCodeReasoningEvidence {
  readonly evidenceId: string;
  readonly kind: 'selected-clip' | 'attached-asset' | 'timeline-range' | 'project-summary';
  readonly label: string;
  readonly detail: string;
}

export interface BrowserJoyCodeReasoningRequest {
  readonly model: string;
  readonly goal: string;
  readonly snapshotDigest: string;
  readonly projectRevision: string;
  readonly idempotencyKey: string;
  readonly privacyMode: 'local-only' | 'ask-before-remote';
  readonly evidence: readonly BrowserJoyCodeReasoningEvidence[];
  readonly allowedIntentIds: readonly string[];
  readonly providerApprovalGrant?: BrowserProviderApprovalGrant;
  readonly maxTokens?: number;
}

export interface BrowserJoyCodeReasoningResponse {
  readonly responseVersion: 1;
  readonly requestId: string;
  readonly brief: {
    readonly summary: string;
    readonly rationale: string;
    readonly evidenceReferences: readonly string[];
    readonly caution?: string;
  };
  readonly proposal?: {
    readonly intentId: string;
    readonly summary: string;
    readonly rationale: string;
    readonly evidenceReferences: readonly string[];
  };
  readonly provider: {
    readonly providerId: string;
    readonly modelId: string;
    readonly decisionRef: string;
    readonly briefRef: string;
    readonly requestDigest: string;
    readonly dataLeavesDevice: boolean;
    readonly retentionDisclosure?: string;
    readonly usage?: {
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly budgetReservationId?: string;
    };
  };
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

export interface BrowserProductionRunListOptions {
  readonly limit?: number;
  readonly cursor?: string;
  readonly state?: ProductionRunRecordV1['state'];
}

export interface BrowserProductionRunListResponse {
  readonly runs: readonly ProductionRunRecordV1[];
  readonly nextCursor?: string;
}

export interface BrowserProductionRunCreateInput {
  readonly runKey: string;
  readonly record: ProductionRunRecordV1;
  readonly authority: ProductionRunAuthority;
  readonly approvalExpiresAt?: number;
}

export interface BrowserProductionRunCancelInput {
  readonly authority: ProductionRunAuthority;
  readonly expectedUpdatedSeq?: number;
}

export interface BrowserProductionRunApprovalResponseInput extends RecordProductionApprovalResponseInput {
  readonly expectedUpdatedSeq?: number;
}

export class BrowserControlPlaneClient {
  constructor(
    private readonly apiUrl = '/api',
    private readonly tokenProvider: () => string | undefined = () =>
      getStoredMediaToken(window.localStorage),
  ) {}

  async workers(): Promise<readonly BrowserWorker[]> {
    return this.get('/v1/workers');
  }
  async jobs(projectId: string): Promise<readonly BrowserJob[]> {
    return browserJobList(
      await this.get<unknown>(`/v1/projects/${encodeURIComponent(projectId)}/jobs`),
    );
  }
  async assets(projectId: string): Promise<readonly BrowserAsset[]> {
    return browserAssetList(
      await this.get<unknown>(`/v1/projects/${encodeURIComponent(projectId)}/assets`),
    );
  }
  /** Owner's private backups plus the explicitly shared curated library. */
  async sharedCloudAssets(): Promise<readonly BrowserAsset[]> {
    return browserAssetList(await this.get<unknown>('/v1/library/cloud-assets'));
  }
  /** All assets owned by this Joy identity across every local editor project. */
  async myAssets(): Promise<readonly BrowserAsset[]> {
    return browserAssetList(await this.get<unknown>('/v1/library/my-assets'));
  }
  /** Safe catalog only: model IDs and lifecycle state, never secret references or values. */
  async reasoningProviders(): Promise<readonly BrowserReasoningProvider[]> {
    const data = await this.get<{ readonly providers: readonly BrowserReasoningProvider[] }>(
      '/v1/providers/reasoning',
    );
    return data.providers;
  }
  async joyCodeReasoning(
    input: BrowserJoyCodeReasoningRequest,
  ): Promise<BrowserJoyCodeReasoningResponse> {
    return this.post('/v1/providers/reasoning/joy-code', input);
  }
  async issueProviderApprovalGrant(input: {
    readonly providerId: string;
    readonly capability: CapabilityId;
    readonly requestDigest: string;
    readonly costCap?: Money;
    readonly expiresAt?: string;
  }): Promise<BrowserProviderApprovalGrant> {
    return this.post('/v1/providers/approvals/grants', input);
  }
  /** Fetch cloud-backed original bytes for any logged-in Joy user. */
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
  async project(id: string): Promise<BrowserProject> {
    return this.get(`/v1/projects/${encodeURIComponent(id)}`);
  }
  async projectDocument(id: string): Promise<BrowserProjectDocumentSnapshot> {
    return browserProjectDocumentSnapshot(
      await this.get<unknown>(`/v2/projects/${encodeURIComponent(id)}/document`),
    );
  }
  async appendProjectRevision(
    projectId: string,
    input: {
      readonly baseRevision: number;
      readonly idempotencyKey: string;
      readonly document: ProjectDocumentV2;
      readonly label?: string;
    },
  ): Promise<BrowserProjectRevision> {
    return browserProjectRevision(
      await this.post<unknown>(`/v2/projects/${encodeURIComponent(projectId)}/revisions`, input),
    );
  }
  async projectRevision(projectId: string, revision: number): Promise<BrowserProjectRevision> {
    return browserProjectRevision(
      await this.get<unknown>(
        `/v2/projects/${encodeURIComponent(projectId)}/revisions/${revision}`,
      ),
    );
  }
  async restoreProjectRevision(
    projectId: string,
    input: {
      readonly baseRevision: number;
      readonly revision: number;
      readonly idempotencyKey: string;
      readonly label?: string;
    },
  ): Promise<BrowserProjectRevision> {
    return browserProjectRevision(
      await this.post<unknown>(`/v2/projects/${encodeURIComponent(projectId)}/restore`, input),
    );
  }
  async recoverStaleRevision(
    sourceProjectId: string,
    input: BrowserProjectRecoveredCopyInput,
  ): Promise<BrowserProjectRecoveredCopy> {
    return browserRecoveredCopy(
      await this.post<unknown>(
        `/v2/projects/${encodeURIComponent(sourceProjectId)}/recovered-copies`,
        input,
      ),
    );
  }
  async ensureProject(id: string, title: string): Promise<BrowserProject> {
    try {
      return await this.createProject(id, title);
    } catch (error) {
      if (
        !(error instanceof BrowserControlPlaneError && error.code === 'PROJECT_EXISTS') &&
        !messageIncludes(error, 'PROJECT_EXISTS')
      )
        throw error;
      return this.project(id);
    }
  }
  async derivatives(projectId: string, assetId: string): Promise<readonly BrowserDerivative[]> {
    return browserDerivativeList(
      await this.get<unknown>(
        `/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/derivatives`,
      ),
    );
  }
  async registerAsset(projectId: string, asset: BrowserAssetRegistration): Promise<BrowserAsset> {
    return browserAsset(
      await this.post<unknown>(`/v1/projects/${encodeURIComponent(projectId)}/assets`, asset),
    );
  }
  /** Owner-only hard delete of catalog asset metadata (and derivative rows). */
  async deleteAsset(projectId: string, assetId: string): Promise<{ readonly id: string }> {
    return this.request(
      `/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`,
      {
        method: 'DELETE',
      },
    );
  }
  /**
   * Upload image original bytes to private cloud (ParsPack) and apply agent tags.
   * Videos are not accepted by the API in v1.
   */
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
    return browserAsset(body.data.asset);
  }
  async retagAsset(projectId: string, assetId: string): Promise<BrowserAsset> {
    return browserAsset(
      await this.post<unknown>(
        `/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/retag`,
        {},
      ),
    );
  }
  async setAssetSync(
    projectId: string,
    enabled: boolean,
  ): Promise<{ readonly assetSyncEnabled: boolean }> {
    return this.post(`/v1/projects/${encodeURIComponent(projectId)}/asset-sync`, { enabled });
  }
  async createProject(id: string, title: string): Promise<BrowserProject> {
    return this.post('/v1/projects', { id, title });
  }
  async enqueueAssetThumbnail(projectId: string, id: string, assetId: string): Promise<BrowserJob> {
    return this.post(`/v1/projects/${encodeURIComponent(projectId)}/jobs`, {
      id,
      type: 'asset.thumbnail',
      assetId,
    });
  }
  async enqueueRenderExport(
    projectId: string,
    id: string,
    payload: RenderJobPayload,
  ): Promise<BrowserJob> {
    return this.enqueueRenderJob(projectId, id, 'render.export', payload);
  }
  async enqueueRenderInspection(
    projectId: string,
    id: string,
    payload: RenderInspectPayload,
  ): Promise<BrowserJob> {
    return this.enqueueRenderJob(projectId, id, 'render.inspect', payload);
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
      | 'audio.ml-denoise'
      | 'text.lm-studio'
      | 'text.openrouter'
      | 'video.runway'
      | 'edit.higgsfield',
    assetId: string,
  ): Promise<BrowserJob> {
    return this.post(`/v1/projects/${encodeURIComponent(projectId)}/jobs`, {
      id,
      type,
      assetId,
    });
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
  async enqueueReferenceAnalysis(
    projectId: string,
    id: string,
    payload: VideoReferenceAnalyzePayload,
  ): Promise<BrowserJob> {
    return this.post(`/v1/projects/${encodeURIComponent(projectId)}/jobs`, {
      id,
      type: 'video.reference-analyze',
      assetId: payload.assetId,
      protocolVersion: WORKER_PROTOCOL_VERSION,
      payload,
      requirements: { capabilities: ['video.reference-analyze'], privacy: 'local-only' },
      idempotencyKey: id,
      maxAttempts: 2,
    });
  }
  async pairWorker(workerId: string, pairingCode: string): Promise<void> {
    await this.post(`/v1/workers/${encodeURIComponent(workerId)}/pair`, { pairingCode });
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

  /** Fetches a verified Worker render artifact only from the authenticated Media API. */
  async renderArtifactBytes(projectId: string, artifactId: string): Promise<Blob> {
    const token = await this.assertion();
    const response = await fetch(
      `${this.apiUrl.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(projectId)}/render-artifacts/${encodeURIComponent(artifactId)}/content`,
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    );
    if (response.status === 401 || response.status === 403)
      throw new DerivativeAuthorityRevokedError();
    if (!response.ok) throw new Error(`render artifact request failed (${response.status})`);
    return response.blob();
  }

  /** Live faster-whisper transcription (authenticated). Falls back is caller's job. */
  async transcribeSpeech(
    language: string,
    options: BrowserSpeechTranscriptionOptions = {},
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
      // The reference endpoint currently accepts only the source identity.
      // Optional source ranges are normalized client-side by local-transcription.
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

  async createProductionRun(
    projectId: string,
    input: BrowserProductionRunCreateInput,
  ): Promise<ProductionRunRecordV1> {
    return this.post(`/v1/projects/${encodeURIComponent(projectId)}/production-runs`, input);
  }

  async productionRuns(
    projectId: string,
    options: BrowserProductionRunListOptions = {},
  ): Promise<BrowserProductionRunListResponse> {
    const search = new URLSearchParams();
    if (options.limit !== undefined) search.set('limit', String(options.limit));
    if (options.cursor !== undefined) search.set('cursor', options.cursor);
    if (options.state !== undefined) search.set('state', options.state);
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return this.get(`/v1/projects/${encodeURIComponent(projectId)}/production-runs${suffix}`);
  }

  async productionRun(projectId: string, runId: string): Promise<ProductionRunRecordV1> {
    return this.get(
      `/v1/projects/${encodeURIComponent(projectId)}/production-runs/${encodeURIComponent(runId)}`,
    );
  }

  async updateProductionRunCheckpoint(
    projectId: string,
    update: ProductionRunCheckpointUpdateV1,
  ): Promise<ProductionRunCheckpointUpdateResultV1> {
    return this.post(
      `/v1/projects/${encodeURIComponent(projectId)}/production-runs/${encodeURIComponent(
        update.runId,
      )}/checkpoint`,
      update,
    );
  }

  async respondToProductionRunApproval(
    projectId: string,
    runId: string,
    response: BrowserProductionRunApprovalResponseInput,
  ): Promise<RecordProductionApprovalResponseResult> {
    return this.post(
      `/v1/projects/${encodeURIComponent(projectId)}/production-runs/${encodeURIComponent(
        runId,
      )}/approvals/${encodeURIComponent(response.approvalId)}/respond`,
      response,
    );
  }

  async cancelProductionRun(
    projectId: string,
    runId: string,
    input: BrowserProductionRunCancelInput,
  ): Promise<ProductionRunRecordV1> {
    return this.post(
      `/v1/projects/${encodeURIComponent(projectId)}/production-runs/${encodeURIComponent(
        runId,
      )}/cancel`,
      input,
    );
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }
  private async post<T>(path: string, body: object): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  private async enqueueRenderJob(
    projectId: string,
    id: string,
    type: 'render.export' | 'render.inspect',
    payload: RenderJobPayload | RenderInspectPayload,
  ): Promise<BrowserJob> {
    return this.post(`/v1/projects/${encodeURIComponent(projectId)}/jobs`, {
      id,
      type,
      protocolVersion: WORKER_PROTOCOL_VERSION,
      payload,
      requirements: { capabilities: [type], privacy: 'local-only' },
      idempotencyKey: id,
      maxAttempts: 3,
    });
  }
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const token = await this.assertion();
    const response = await fetch(`${this.apiUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}` },
    });
    const body = await responseBody(response);
    if (!response.ok) throw controlPlaneError(body, response.status);
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

function errorMessage(body: unknown, status: number): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
    const code = typeof body.error.code === 'string' ? `${body.error.code}: ` : '';
    return `${code}${body.error.message}`;
  }
  if (isRecord(body) && typeof body.error === 'string') return body.error;
  return `JOY Media request failed (${status})`;
}

function controlPlaneError(body: unknown, status: number): Error {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
    const code = typeof body.error.code === 'string' ? body.error.code : 'REQUEST_FAILED';
    const preflight = isRecord(body.error.preflight)
      ? (body.error.preflight as unknown as BrowserProviderApprovalPreflight)
      : undefined;
    return new BrowserControlPlaneError(code, body.error.message, status, preflight);
  }
  return new Error(errorMessage(body, status));
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

function browserProjectDocumentSnapshot(value: unknown): BrowserProjectDocumentSnapshot {
  if (!isRecord(value)) throw invalidProjectResponse();
  const projectId = projectResponseString(value.projectId);
  return {
    projectId,
    revision: projectResponsePositiveInteger(value.revision),
    document: browserProjectDocument(value.document, projectId),
    documentHash: projectResponseString(value.documentHash),
    updatedAt: projectResponseString(value.updatedAt),
  };
}

function browserProjectRevision(value: unknown): BrowserProjectRevision {
  if (!isRecord(value)) throw invalidProjectResponse();
  const projectId = projectResponseString(value.projectId);
  return {
    projectId,
    revision: projectResponsePositiveInteger(value.revision),
    baseRevision: projectResponseNonNegativeInteger(value.baseRevision),
    idempotencyKey: projectResponseString(value.idempotencyKey),
    operation: browserProjectRevisionOperation(value.operation),
    document: browserProjectDocument(value.document, projectId),
    documentHash: projectResponseString(value.documentHash),
    createdAt: projectResponseString(value.createdAt),
  };
}

function browserProjectRevisionOperation(value: unknown): BrowserProjectRevision['operation'] {
  if (!isRecord(value) || (value.kind !== 'replace' && value.kind !== 'restore'))
    throw invalidProjectResponse();
  const label = optionalProjectResponseString(value.label);
  const targetRevision = optionalProjectResponsePositiveInteger(value.targetRevision);
  if (value.kind === 'restore' && targetRevision === undefined) throw invalidProjectResponse();
  return {
    kind: value.kind,
    idempotencyKey: projectResponseString(value.idempotencyKey),
    ...(label === undefined ? {} : { label }),
    ...(targetRevision === undefined ? {} : { targetRevision }),
  };
}

function browserRecoveredCopy(value: unknown): BrowserProjectRecoveredCopy {
  if (!isRecord(value) || value.kind !== 'recovered-copy' || !isRecord(value.provenance))
    throw invalidProjectResponse();
  const projectId = projectResponseString(value.projectId);
  const provenance = value.provenance;
  return {
    kind: 'recovered-copy',
    projectId,
    name: projectResponseString(value.name),
    document: browserProjectDocument(value.document, projectId),
    basedOnRevision: projectResponseNonNegativeInteger(value.basedOnRevision),
    serverRevision: projectResponsePositiveInteger(value.serverRevision),
    createdAt: projectResponseString(value.createdAt),
    provenance: {
      sourceProjectId: projectResponseString(provenance.sourceProjectId),
      baseRevision: projectResponseNonNegativeInteger(provenance.baseRevision),
      sourceHeadRevision: projectResponseNonNegativeInteger(provenance.sourceHeadRevision),
      operation: browserRecoveredOperation(provenance.operation),
      requestedDocumentHash: projectResponseString(provenance.requestedDocumentHash),
    },
  };
}

function browserRecoveredOperation(value: unknown): BrowserRecoveredCopyOperation {
  if (!isRecord(value)) throw invalidProjectResponse();
  const label = optionalProjectResponseString(value.label);
  if (value.kind === 'append') {
    return {
      kind: 'append',
      document: browserProjectDocument(value.document),
      ...(label === undefined ? {} : { label }),
    };
  }
  if (value.kind === 'restore') {
    return {
      kind: 'restore',
      targetRevision: projectResponsePositiveInteger(value.targetRevision),
      ...(label === undefined ? {} : { label }),
    };
  }
  throw invalidProjectResponse();
}

function browserProjectDocument(value: unknown, expectedProjectId?: string): ProjectDocumentV2 {
  const diagnostics = validateProjectDocumentV2(value);
  if (diagnostics.length > 0) throw invalidProjectResponse();
  const document = value as ProjectDocumentV2;
  if (expectedProjectId !== undefined && document.projectId !== expectedProjectId)
    throw invalidProjectResponse();
  return JSON.parse(JSON.stringify(document)) as ProjectDocumentV2;
}

function projectResponseString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw invalidProjectResponse();
  return value;
}

function optionalProjectResponseString(value: unknown): string | undefined {
  return value === undefined ? undefined : projectResponseString(value);
}

function projectResponsePositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalidProjectResponse();
  return value as number;
}

function projectResponseNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidProjectResponse();
  return value as number;
}

function optionalProjectResponsePositiveInteger(value: unknown): number | undefined {
  return value === undefined ? undefined : projectResponsePositiveInteger(value);
}

function invalidProjectResponse(): Error {
  return new Error('JOY Media API returned an invalid project response');
}

function browserAssetList(value: unknown): readonly BrowserAsset[] {
  if (!Array.isArray(value)) throw invalidAssetResponse();
  return value.map(browserAsset);
}

function browserJobList(value: unknown): readonly BrowserJob[] {
  if (!Array.isArray(value)) throw invalidJobResponse();
  return value.map(browserJob);
}

function browserJob(value: unknown): BrowserJob {
  if (!isRecord(value)) throw invalidJobResponse();
  const state = value.state;
  if (
    state !== 'queued' &&
    state !== 'leased' &&
    state !== 'completed' &&
    state !== 'canceled' &&
    state !== 'failed'
  )
    throw invalidJobResponse();
  if (typeof value.cancelRequested !== 'boolean') throw invalidJobResponse();
  const payload = optionalSafeJobRecord(value.payload);
  const derivative =
    value.derivative === undefined ? undefined : browserJobDerivative(value.derivative);
  const assetId = optionalOpaqueJobReference(value.assetId);
  const error = optionalSafeJobString(value.error);
  return {
    id: opaqueJobReference(value.id),
    projectId: opaqueJobReference(value.projectId),
    type: opaqueJobReference(value.type),
    ...(assetId === undefined ? {} : { assetId }),
    ...(payload === undefined
      ? {}
      : { payload: payload as Partial<RenderJobPayload> & Record<string, unknown> }),
    state,
    progress: responseNonNegativeInteger(value.progress),
    cancelRequested: value.cancelRequested,
    ...(error === undefined ? {} : { error }),
    ...(derivative === undefined ? {} : { derivative }),
  };
}

function browserJobDerivative(value: unknown): NonNullable<BrowserJob['derivative']> {
  if (!isRecord(value)) throw invalidJobResponse();
  const assetId = optionalOpaqueJobReference(value.assetId);
  const reportRef = optionalOpaqueJobReference(value.reportRef);
  const outputRef = optionalOpaqueJobReference(value.outputRef);
  const sha256 = value.sha256 === undefined ? undefined : responseSha256(value.sha256);
  const bytes = optionalPositiveIntegerResponse(value.bytes);
  const model = optionalSafeJobString(value.model);
  const descriptor =
    value.descriptor === undefined ? undefined : browserMediaDescriptor(value.descriptor);
  const evidenceIds = optionalOpaqueJobReferenceArray(value.evidenceIds);
  const findings = optionalSafeJobValue(value.findings);
  if (findings !== undefined && typeof findings !== 'number' && !Array.isArray(findings))
    throw invalidJobResponse();
  const evidence = optionalSafeJobValue(value.evidence);
  if (evidence !== undefined && !Array.isArray(evidence)) throw invalidJobResponse();
  const qualityReport = optionalSafeJobRecord(value.qualityReport);
  const report = optionalSafeJobRecord(value.report);
  return {
    jobId: opaqueJobReference(value.jobId),
    kind: opaqueJobReference(value.kind),
    ...(assetId === undefined ? {} : { assetId }),
    ...(reportRef === undefined ? {} : { reportRef }),
    ...(outputRef === undefined ? {} : { outputRef }),
    ...(findings === undefined ? {} : { findings: findings as number | readonly unknown[] }),
    ...(qualityReport === undefined
      ? {}
      : { qualityReport: qualityReport as unknown as BrowserRenderReport }),
    ...(report === undefined ? {} : { report: report as unknown as BrowserRenderReport }),
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(descriptor === undefined ? {} : { descriptor }),
    ...(value.summary === undefined ? {} : { summary: safeJobValue(value.summary) }),
    ...(evidence === undefined ? {} : { evidence: evidence as readonly unknown[] }),
    ...(evidenceIds === undefined ? {} : { evidenceIds }),
    workerRef: opaqueJobReference(value.workerRef),
    resultRef: jobResultReference(value.resultRef),
    verifiedAt: responseNonNegativeInteger(value.verifiedAt),
    ...(model === undefined ? {} : { model }),
  };
}

const STORAGE_BEARING_JOB_KEYS = new Set([
  'localref',
  'localrefs',
  'localpath',
  'localpaths',
  'location',
  'locations',
  'objectkey',
  'objectkeys',
  'storagekey',
  'storagekeys',
  'bucketkey',
  'bucketkeys',
  'privateobjectref',
  'privateobjectrefs',
  'cloudref',
  'cloudrefs',
  'path',
  'paths',
  'filepath',
  'filepaths',
  'url',
  'urls',
  'uri',
  'uris',
]);

function optionalSafeJobRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw invalidJobResponse();
  safeJobValue(value);
  return value;
}

function optionalSafeJobValue(value: unknown): unknown {
  return value === undefined ? undefined : safeJobValue(value);
}

function safeJobValue(value: unknown): unknown {
  if (typeof value === 'string' && looksLikeStorageLocator(value)) throw invalidJobResponse();
  if (Array.isArray(value)) {
    value.forEach(safeJobValue);
    return value;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (STORAGE_BEARING_JOB_KEYS.has(canonicalJobKey(key))) throw invalidJobResponse();
      safeJobValue(child);
    }
  }
  return value;
}

function canonicalJobKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function optionalSafeJobString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const result = responseString(value);
  safeJobValue(result);
  return result;
}

function opaqueJobReference(value: unknown): string {
  const result = responseString(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result) || looksLikeStorageLocator(result))
    throw invalidJobResponse();
  return result;
}

function optionalOpaqueJobReference(value: unknown): string | undefined {
  return value === undefined ? undefined : opaqueJobReference(value);
}

function optionalOpaqueJobReferenceArray(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalidJobResponse();
  return value.map(opaqueJobReference);
}

function jobResultReference(value: unknown): string {
  const result = responseString(value);
  if (result.startsWith('derivative:')) {
    opaqueJobReference(result.slice('derivative:'.length));
    return result;
  }
  return opaqueJobReference(result);
}

function looksLikeStorageLocator(value: string): boolean {
  return (
    /^(?:file:|https?:\/\/)/i.test(value) ||
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\')
  );
}

function browserAsset(value: unknown): BrowserAsset {
  if (!isRecord(value)) throw invalidAssetResponse();
  const kind = value.kind;
  if (kind !== 'video' && kind !== 'audio' && kind !== 'image' && kind !== 'model')
    throw invalidAssetResponse();
  const tags = optionalStringArray(value.tags);
  const sortName = optionalString(value.sortName);
  return {
    id: responseString(value.id),
    projectId: responseString(value.projectId),
    kind,
    displayName: responseString(value.displayName),
    sha256: responseSha256(value.sha256),
    bytes: responsePositiveInteger(value.bytes),
    descriptor: browserMediaDescriptor(value.descriptor),
    ...(tags === undefined ? {} : { tags }),
    ...(sortName === undefined ? {} : { sortName }),
    createdAt: responseNonNegativeInteger(value.createdAt),
  };
}

function browserDerivativeList(value: unknown): readonly BrowserDerivative[] {
  if (!Array.isArray(value)) throw invalidAssetResponse();
  return value.map(browserDerivative);
}

function browserDerivative(value: unknown): BrowserDerivative {
  if (!isRecord(value)) throw invalidAssetResponse();
  const kind = value.kind;
  const availability = value.availability;
  if (kind !== 'thumbnail' && kind !== 'proxy') throw invalidAssetResponse();
  if (
    availability !== 'pending' &&
    availability !== 'available-local' &&
    availability !== 'available-cloud' &&
    availability !== 'evicted' &&
    availability !== 'invalid'
  )
    throw invalidAssetResponse();
  return {
    id: responseString(value.id),
    projectId: responseString(value.projectId),
    assetId: responseString(value.assetId),
    kind,
    profile: responseString(value.profile),
    sha256: responseSha256(value.sha256),
    bytes: responsePositiveInteger(value.bytes),
    descriptor: browserMediaDescriptor(value.descriptor),
    availability,
    verifiedAt: responseNonNegativeInteger(value.verifiedAt),
  };
}

function browserMediaDescriptor(value: unknown): BrowserMediaDescriptor {
  if (!isRecord(value)) throw invalidAssetResponse();
  const durationUs = optionalPositiveIntegerResponse(value.durationUs);
  const width = optionalPositiveIntegerResponse(value.width);
  const height = optionalPositiveIntegerResponse(value.height);
  return {
    mimeType: responseString(value.mimeType),
    ...(durationUs === undefined ? {} : { durationUs }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

function responseString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw invalidAssetResponse();
  return value;
}

function responseSha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw invalidAssetResponse();
  return value;
}

function responsePositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalidAssetResponse();
  return value as number;
}

function responseNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidAssetResponse();
  return value as number;
}

function optionalPositiveIntegerResponse(value: unknown): number | undefined {
  return value === undefined ? undefined : responsePositiveInteger(value);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return responseString(value);
}

function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw invalidAssetResponse();
  return value as readonly string[];
}

function invalidAssetResponse(): Error {
  return new Error('JOY Media API returned an invalid asset response');
}

function invalidJobResponse(): Error {
  return new Error('JOY Media API returned an invalid job response');
}

function messageIncludes(error: unknown, code: string): boolean {
  return error instanceof Error && error.message.includes(code);
}
