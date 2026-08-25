import { randomBytes } from 'node:crypto';
import type {
  MediaSemanticIndexEvidence,
  ReferenceAnalysisEvidence,
  ReferenceAnalysisFinding,
} from '@joy-media/job-protocol';
import type { DeviceIdentity } from './runtime.js';

export interface WorkerSessionStore {
  loadWorkerSession(): string | undefined;
  saveWorkerSession(sessionToken: string): void;
  clearWorkerSession(): void;
}

export interface LeasedJob {
  readonly id: string;
  readonly projectId: string;
  readonly type: string;
  readonly assetId?: string;
  readonly payload?: Record<string, unknown>;
  readonly requirements?: {
    readonly capabilities: readonly string[];
    readonly privacy: string;
  };
  readonly idempotencyKey?: string;
  readonly maxAttempts?: number;
}
export interface WorkerJobResult {
  readonly kind:
    | 'asset.thumbnail'
    | 'image.comfy'
    | 'audio.ml-denoise'
    | 'video.reference-analyze'
    | 'media.semantic-index'
    | 'render.export'
    | 'render.inspect'
    | 'text.lm-studio'
    | 'text.openrouter'
    | 'video.runway'
    | 'edit.higgsfield';
  readonly assetId?: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly localRef?: string;
  readonly resultRef?: string;
  readonly reportRef?: string;
  readonly outputRef?: string;
  readonly findings?: number | readonly ReferenceAnalysisFinding[];
  readonly qualityReport?: unknown;
  readonly descriptor?: {
    readonly mimeType: string;
    readonly width?: number;
    readonly height?: number;
    readonly durationUs?: number;
  };
  readonly summary?:
    | {
        readonly shotCount: number;
        readonly cutCount: number;
        readonly averageShotDurationUs: number;
        readonly fastestShotDurationUs: number;
        readonly sampleCount: number;
        readonly transcriptSegmentCount: number;
        readonly audioBeatCount: number;
      }
    | {
        readonly assetCount: number;
        readonly rangeCount: number;
        readonly evidenceCount: number;
        readonly embeddedRangeCount: number;
        readonly reranked: boolean;
      };
  readonly evidence?: readonly (ReferenceAnalysisEvidence | MediaSemanticIndexEvidence)[];
  readonly evidenceIds?: readonly string[];
  readonly assets?: readonly unknown[];
  readonly provider?: string;
  readonly text?: string;
  readonly model?: string;
}

export interface WorkerControlPlaneClientOptions {
  readonly apiUrl: string;
  readonly identity: DeviceIdentity;
  readonly sessionStore: WorkerSessionStore;
  readonly fetch?: typeof fetch;
}

/** Outbound-only Worker client. It never holds a JOY user session or password. */
export class WorkerControlPlaneClient {
  readonly #fetch: typeof fetch;

  constructor(private readonly options: WorkerControlPlaneClientOptions) {
    this.#fetch = options.fetch ?? fetch;
  }

  static createPairingCode(): string {
    return randomBytes(24).toString('base64url');
  }

  async publishPairingOffer(pairingCode: string): Promise<number> {
    const result = await this.request('/v1/worker-pair/offers', {
      workerId: this.options.identity.workerId,
      pairingCode,
    });
    return requiredNumber(result, 'expiresAt');
  }

  /** Returns undefined until the signed-in JOY user approves the pairing code. */
  async claimPairing(pairingCode: string): Promise<boolean> {
    const response = await this.request(
      '/v1/worker-pair/claim',
      {
        workerId: this.options.identity.workerId,
        pairingCode,
      },
      false,
    );
    if (response === undefined) return false;
    this.options.sessionStore.saveWorkerSession(requiredString(response, 'sessionToken'));
    return true;
  }

  async lease(durationMs = 30_000): Promise<LeasedJob | undefined> {
    const result = await this.authenticatedRequest(
      `/v1/workers/${encodeURIComponent(this.options.identity.workerId)}/leases`,
      { durationMs },
    );
    if (result === null) return undefined;
    const assetId =
      isRecord(result) && typeof result.assetId === 'string' ? result.assetId : undefined;
    const payload = isRecord(result) && isRecord(result.payload) ? result.payload : undefined;
    const requirements =
      isRecord(result) && isRequirements(result.requirements) ? result.requirements : undefined;
    const idempotencyKey =
      isRecord(result) && typeof result.idempotencyKey === 'string'
        ? result.idempotencyKey
        : undefined;
    const maxAttempts =
      isRecord(result) &&
      typeof result.maxAttempts === 'number' &&
      Number.isSafeInteger(result.maxAttempts)
        ? result.maxAttempts
        : undefined;
    return {
      id: requiredString(result, 'id'),
      projectId: requiredString(result, 'projectId'),
      type: requiredString(result, 'type'),
      ...(assetId === undefined ? {} : { assetId }),
      ...(payload === undefined ? {} : { payload }),
      ...(requirements === undefined ? {} : { requirements }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
    };
  }

  async hello(capabilities: readonly string[], assetIds: readonly string[]): Promise<void> {
    await this.authenticatedRequest(
      `/v1/workers/${encodeURIComponent(this.options.identity.workerId)}/hello`,
      { capabilities, assetIds },
    );
  }

  async heartbeat(jobId: string, progress: number): Promise<{ readonly cancelRequested: boolean }> {
    const result = await this.authenticatedRequest(
      `/v1/workers/${encodeURIComponent(this.options.identity.workerId)}/jobs/${encodeURIComponent(jobId)}/heartbeat`,
      { progress },
    );
    if (!isRecord(result) || typeof result.cancelRequested !== 'boolean')
      throw new Error('Invalid Worker response: cancelRequested');
    return { cancelRequested: result.cancelRequested };
  }

  async complete(jobId: string, result: WorkerJobResult): Promise<void> {
    await this.authenticatedRequest(
      `/v1/workers/${encodeURIComponent(this.options.identity.workerId)}/jobs/${encodeURIComponent(jobId)}/complete`,
      { result },
    );
  }

  async uploadDerivative(jobId: string, result: WorkerJobResult, bytes: Uint8Array): Promise<void> {
    const sessionToken = this.options.sessionStore.loadWorkerSession();
    if (sessionToken === undefined) throw new Error('Worker is not paired');
    const headers: Record<string, string> = {
      authorization: `Bearer ${sessionToken}`,
      accept: 'application/json',
      'content-type': result.descriptor?.mimeType ?? 'application/octet-stream',
      'user-agent': process.env.JOY_MEDIA_WORKER_USER_AGENT?.trim() || 'JOY-Media-Worker/0.1',
      'x-joy-asset-id': result.assetId ?? jobId,
      'x-joy-sha256': result.sha256 ?? '',
      'x-joy-bytes': String(result.bytes ?? 0),
    };
    if (result.descriptor?.width !== undefined)
      headers['x-joy-width'] = String(result.descriptor.width);
    if (result.descriptor?.height !== undefined)
      headers['x-joy-height'] = String(result.descriptor.height);
    const response = await this.#fetch(
      `${this.options.apiUrl.replace(/\/$/, '')}/v1/workers/${encodeURIComponent(this.options.identity.workerId)}/jobs/${encodeURIComponent(jobId)}/derivative`,
      {
        method: 'POST',
        headers,
        body: bytes,
      },
    );
    if (response.status === 401) {
      this.options.sessionStore.clearWorkerSession();
      throw new Error('Worker session expired or was revoked');
    }
    if (!response.ok) throw new Error(`Worker derivative upload failed (${response.status})`);
  }

  async uploadRenderArtifact(
    jobId: string,
    result: WorkerJobResult,
    bytes: Uint8Array,
  ): Promise<void> {
    if (result.kind !== 'render.export' || result.outputRef === undefined)
      throw new Error('render artifact upload requires a render.export result');
    const sessionToken = this.options.sessionStore.loadWorkerSession();
    if (sessionToken === undefined) throw new Error('Worker is not paired');
    const headers: Record<string, string> = {
      authorization: `Bearer ${sessionToken}`,
      accept: 'application/json',
      'content-type': 'video/mp4',
      'user-agent': process.env.JOY_MEDIA_WORKER_USER_AGENT?.trim() || 'JOY-Media-Worker/0.1',
      'x-joy-output-ref': result.outputRef,
      'x-joy-sha256': result.sha256 ?? '',
      'x-joy-bytes': String(result.bytes ?? 0),
    };
    const response = await this.#fetch(
      `${this.options.apiUrl.replace(/\/$/, '')}/v1/workers/${encodeURIComponent(this.options.identity.workerId)}/jobs/${encodeURIComponent(jobId)}/artifact`,
      { method: 'POST', headers, body: bytes },
    );
    if (response.status === 401) {
      this.options.sessionStore.clearWorkerSession();
      throw new Error('Worker session expired or was revoked');
    }
    if (!response.ok) throw new Error(`Worker render artifact upload failed (${response.status})`);
  }

  async fail(jobId: string, error: string): Promise<void> {
    await this.authenticatedRequest(
      `/v1/workers/${encodeURIComponent(this.options.identity.workerId)}/jobs/${encodeURIComponent(jobId)}/fail`,
      { error },
    );
  }

  private async authenticatedRequest(
    pathname: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const sessionToken = this.options.sessionStore.loadWorkerSession();
    if (sessionToken === undefined) throw new Error('Worker is not paired');
    const response = await this.fetchJson(pathname, body, sessionToken);
    if (response.status === 401) {
      this.options.sessionStore.clearWorkerSession();
      throw new Error('Worker session expired or was revoked');
    }
    if (!response.ok) throw new Error(`Worker control-plane request failed (${response.status})`);
    return response.body;
  }

  private async request(
    pathname: string,
    body: Record<string, unknown>,
    throwOnFailure = true,
  ): Promise<unknown | undefined> {
    const response = await this.fetchJson(pathname, body);
    if (!response.ok) {
      if (!throwOnFailure && response.status === 403) return undefined;
      throw new Error(`Worker control-plane request failed (${response.status})`);
    }
    return response.body;
  }

  private async fetchJson(
    pathname: string,
    body: Record<string, unknown>,
    sessionToken?: string,
  ): Promise<{ readonly ok: boolean; readonly status: number; readonly body: unknown }> {
    const url = `${this.options.apiUrl.replace(/\/$/, '')}${pathname}`;
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        // Cloudflare bot checks sometimes challenge bare undici/Node UAs from
        // residential networks; identify as JOY Worker and prefer JSON.
        'user-agent': process.env.JOY_MEDIA_WORKER_USER_AGENT?.trim() || 'JOY-Media-Worker/0.1',
        ...(sessionToken === undefined ? {} : { authorization: `Bearer ${sessionToken}` }),
      },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    let envelope: unknown;
    try {
      envelope = raw.length === 0 ? null : JSON.parse(raw);
    } catch {
      const prefix = raw.replace(/\s+/g, ' ').slice(0, 160);
      throw new Error(
        `Worker control-plane returned non-JSON (${response.status}) from ${url}: ${prefix}`,
      );
    }
    const bodyValue = isRecord(envelope) && 'data' in envelope ? envelope.data : envelope;
    return { ok: response.ok, status: response.status, body: bodyValue };
  }
}

function requiredString(value: unknown, field: string): string {
  if (!isRecord(value) || typeof value[field] !== 'string')
    throw new Error(`Invalid Worker response: ${field}`);
  return value[field];
}

function requiredNumber(value: unknown, field: string): number {
  if (!isRecord(value) || typeof value[field] !== 'number')
    throw new Error(`Invalid Worker response: ${field}`);
  return value[field];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRequirements(value: unknown): value is LeasedJob['requirements'] {
  return (
    isRecord(value) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((item) => typeof item === 'string') &&
    typeof value.privacy === 'string'
  );
}
