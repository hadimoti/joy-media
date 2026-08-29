import { randomBytes } from 'node:crypto';
import type { DeviceIdentity } from './runtime.js';
import type { GpuPreviewFrameRequest, GpuPreviewFrameResponse } from '@joy-media/job-protocol';

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
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly leaseToken: string;
}
export interface WorkerJobResult {
  readonly kind:
    | 'asset.thumbnail'
    | 'fixture.thumbnail'
    | 'image.comfy'
    | 'upscale.image'
    | 'upscale.video'
    | 'audio.ml-denoise'
    | 'mask.image'
    | 'mask.video'
    | 'text'
    | 'image'
    | 'video';
  readonly assetId?: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly localRef?: string;
  readonly descriptor?: {
    readonly mimeType: string;
    readonly width?: number;
    readonly height?: number;
    readonly durationUs?: number;
  };
  readonly provider?: string;
  readonly text?: string;
  readonly model?: string;
  readonly modelId?: string;
  readonly modelVersion?: string;
}

export interface WorkerControlPlaneClientOptions {
  readonly apiUrl: string;
  readonly identity: DeviceIdentity;
  readonly sessionStore: WorkerSessionStore;
  readonly fetch?: typeof fetch;
}

/**
 * Signals that the persisted Worker session is no longer usable. The daemon
 * must stop so its supervisor can restart it through the pairing flow instead
 * of polling forever with an empty session.
 */
export class WorkerSessionExpiredError extends Error {
  constructor() {
    super('Worker session expired or was revoked');
    this.name = 'WorkerSessionExpiredError';
  }
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
    const leaseToken = requiredString(result, 'leaseToken');
    return {
      id: requiredString(result, 'id'),
      projectId: requiredString(result, 'projectId'),
      type: requiredString(result, 'type'),
      ...(assetId === undefined ? {} : { assetId }),
      ...(payload === undefined ? {} : { payload }),
      leaseToken,
    };
  }

  async hello(capabilities: readonly string[], assetIds: readonly string[]): Promise<void> {
    await this.authenticatedRequest(
      `/v1/workers/${encodeURIComponent(this.options.identity.workerId)}/hello`,
      { capabilities, assetIds },
    );
  }

  async nextGpuPreview(): Promise<GpuPreviewFrameRequest | undefined> {
    const result = await this.authenticatedRequest(
      `/v1/workers/${encodeURIComponent(this.options.identity.workerId)}/preview/next`,
      {},
    );
    return result === null || result === undefined ? undefined : (result as GpuPreviewFrameRequest);
  }

  async completeGpuPreview(response: GpuPreviewFrameResponse): Promise<void> {
    await this.authenticatedRequest(
      `/v1/workers/${encodeURIComponent(this.options.identity.workerId)}/preview/frames/${encodeURIComponent(response.sessionId)}/${response.requestId}`,
      {
        protocolVersion: response.protocolVersion,
        sessionId: response.sessionId,
        requestId: response.requestId,
        renderer: response.renderer,
        quality: response.quality,
        width: response.width,
        height: response.height,
        bytesBase64: Buffer.from(response.bytes).toString('base64'),
      },
    );
  }

  async heartbeat(
    jobId: string,
    progress: number,
    leaseToken?: string,
  ): Promise<{ readonly cancelRequested: boolean }> {
    const result = await this.authenticatedRequest(
      `/v1/workers/${encodeURIComponent(this.options.identity.workerId)}/jobs/${encodeURIComponent(jobId)}/heartbeat`,
      { progress, leaseToken: leaseToken ?? '' },
    );
    if (!isRecord(result) || typeof result.cancelRequested !== 'boolean')
      throw new Error('Invalid Worker response: cancelRequested');
    return { cancelRequested: result.cancelRequested };
  }

  async complete(jobId: string, result: WorkerJobResult, leaseToken?: string): Promise<void> {
    await this.authenticatedRequest(
      `/v1/workers/${encodeURIComponent(this.options.identity.workerId)}/jobs/${encodeURIComponent(jobId)}/complete`,
      { result, leaseToken: leaseToken ?? '' },
    );
  }

  async uploadDerivative(
    jobId: string,
    result: WorkerJobResult,
    bytes: Uint8Array,
    leaseToken?: string,
  ): Promise<void> {
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
      'x-joy-derivative-kind':
        result.kind === 'asset.thumbnail'
          ? 'thumbnail'
          : result.kind === 'mask.image' || result.kind === 'mask.video'
            ? 'mask'
            : result.kind === 'upscale.image' || result.kind === 'upscale.video'
              ? 'upscale'
              : 'audio',
      'x-joy-lease-token': leaseToken ?? '',
    };
    if (result.descriptor?.width !== undefined)
      headers['x-joy-width'] = String(result.descriptor.width);
    if (result.descriptor?.height !== undefined)
      headers['x-joy-height'] = String(result.descriptor.height);
    if (result.descriptor?.durationUs !== undefined)
      headers['x-joy-duration-us'] = String(result.descriptor.durationUs);
    const response = await this.#fetch(
      `${this.options.apiUrl.replace(/\/$/, '')}/v1/workers/${encodeURIComponent(this.options.identity.workerId)}/jobs/${encodeURIComponent(jobId)}/derivative`,
      {
        method: 'POST',
        headers,
        body: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      },
    );
    if (response.status === 401) {
      this.options.sessionStore.clearWorkerSession();
      throw new WorkerSessionExpiredError();
    }
    if (!response.ok) throw new Error(`Worker derivative upload failed (${response.status})`);
  }

  async fail(jobId: string, error: string, leaseToken?: string): Promise<void> {
    await this.authenticatedRequest(
      `/v1/workers/${encodeURIComponent(this.options.identity.workerId)}/jobs/${encodeURIComponent(jobId)}/fail`,
      { error, leaseToken: leaseToken ?? '' },
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
      throw new WorkerSessionExpiredError();
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
