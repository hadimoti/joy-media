import { WORKER_PROTOCOL_VERSION, type WorkerCapability } from './protocol.js';

export type PreviewQuality = 'quarter' | 'half' | 'full';

export interface GpuPreviewFrameRequest {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly capability: Extract<WorkerCapability, 'render.preview.gpu'>;
  readonly sessionId: string;
  readonly requestId: number;
  readonly projectId: string;
  readonly projectRevisionId: string;
  readonly compositionId: string;
  readonly timeUs: number;
  readonly quality: PreviewQuality;
  readonly deadlineMs: number;
  /** Ephemeral session bearer; never a durable project credential. */
  readonly sessionToken?: string;
  /** Opaque per-asset grants; filesystem paths are forbidden. */
  readonly assetTokens?: readonly PreviewAssetToken[];
  /** Preview responses must never be stored by intermediaries. */
  readonly noStore?: true;
}

export interface PreviewAssetToken {
  readonly assetId: string;
  readonly token: string;
  readonly expiresAtMs: number;
}

export interface GpuPreviewSession {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly projectId: string;
  readonly subject: string;
  readonly expiresAtMs: number;
}

export interface OpenGpuPreviewSessionInput {
  readonly sessionId: string;
  readonly projectId: string;
  readonly subject: string;
  readonly ttlMs: number;
}

/** Minimal in-memory authorization broker used by API/Worker adapters. */
export class GpuPreviewSessionBroker {
  readonly #sessions = new Map<string, GpuPreviewSession>();
  #nextToken = 1;

  open(input: OpenGpuPreviewSessionInput, nowMs = Date.now()): GpuPreviewSession {
    if (
      input.sessionId.length === 0 ||
      input.projectId.length === 0 ||
      input.subject.length === 0 ||
      !Number.isSafeInteger(input.ttlMs) ||
      input.ttlMs < 1_000 ||
      input.ttlMs > 15 * 60_000
    ) {
      throw new Error('invalid GPU preview session request');
    }
    const session: GpuPreviewSession = {
      sessionId: input.sessionId,
      sessionToken: `preview-session-${this.#nextToken++}`,
      projectId: input.projectId,
      subject: input.subject,
      expiresAtMs: nowMs + input.ttlMs,
    };
    this.#sessions.set(session.sessionId, session);
    return session;
  }

  authorize(
    request: Pick<GpuPreviewFrameRequest, 'sessionId' | 'sessionToken' | 'projectId'>,
    nowMs = Date.now(),
  ): boolean {
    const session = this.#sessions.get(request.sessionId);
    return (
      session !== undefined &&
      request.sessionToken === session.sessionToken &&
      request.projectId === session.projectId &&
      nowMs < session.expiresAtMs
    );
  }

  revoke(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }
}

export function validateGpuPreviewFrameRequest(
  request: GpuPreviewFrameRequest,
  nowMs = Date.now(),
): readonly string[] {
  const errors: string[] = [];
  if (request.protocolVersion !== WORKER_PROTOCOL_VERSION) errors.push('protocolVersion');
  if (
    request.sessionId.length === 0 ||
    typeof request.sessionToken !== 'string' ||
    request.sessionToken.length === 0
  )
    errors.push('session authorization');
  if (!Number.isSafeInteger(request.requestId) || request.requestId < 0) errors.push('requestId');
  if (!Number.isSafeInteger(request.timeUs) || request.timeUs < 0) errors.push('timeUs');
  if (
    !Number.isSafeInteger(request.deadlineMs) ||
    request.deadlineMs < 1 ||
    request.deadlineMs > 5_000
  )
    errors.push('deadlineMs');
  if (request.noStore !== true) errors.push('noStore');
  for (const asset of request.assetTokens ?? []) {
    if (asset.assetId.length === 0 || asset.token.length === 0 || asset.expiresAtMs <= nowMs)
      errors.push(`assetToken:${asset.assetId}`);
  }
  return errors;
}

export interface GpuPreviewFrameResponse {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly requestId: number;
  readonly renderer: 'hardware-gpu';
  readonly quality: PreviewQuality;
  readonly width: number;
  readonly height: number;
  /** Ephemeral encoded frame bytes; never a durable asset reference. */
  readonly bytes: Uint8Array;
}

export interface GpuPreviewRequestGateLimits {
  readonly maxRequestsPerSecond?: number;
  readonly maxAssetTokens?: number;
  readonly maxFrameBytes?: number;
  readonly maxDimension?: number;
}

export interface GpuPreviewAdmission {
  readonly accepted: boolean;
  readonly reason?:
    | 'invalid-request'
    | 'unauthorized'
    | 'asset-limit'
    | 'expired-asset-token'
    | 'replayed-request'
    | 'rate-limit';
}

/**
 * Stateless-at-the-wire limits for an ephemeral preview session. The API or
 * Worker adapter owns the instance; no durable job is created for pointer
 * moves. Request ids are monotonic per session so late/replayed frames cannot
 * become authoritative after a newer scrub request.
 */
export class GpuPreviewRequestGate {
  readonly #limits: Required<GpuPreviewRequestGateLimits>;
  readonly #lastRequestBySession = new Map<string, number>();
  readonly #requestTimesBySession = new Map<string, number[]>();

  constructor(
    limits: GpuPreviewRequestGateLimits = {},
    private readonly authorize: (
      request: Pick<GpuPreviewFrameRequest, 'sessionId' | 'sessionToken' | 'projectId'>,
      nowMs: number,
    ) => boolean = () => true,
  ) {
    this.#limits = {
      maxRequestsPerSecond: limits.maxRequestsPerSecond ?? 30,
      maxAssetTokens: limits.maxAssetTokens ?? 64,
      maxFrameBytes: limits.maxFrameBytes ?? 16 * 1024 * 1024,
      maxDimension: limits.maxDimension ?? 4_096,
    };
    if (
      !Number.isSafeInteger(this.#limits.maxRequestsPerSecond) ||
      this.#limits.maxRequestsPerSecond < 1 ||
      !Number.isSafeInteger(this.#limits.maxAssetTokens) ||
      this.#limits.maxAssetTokens < 1 ||
      !Number.isSafeInteger(this.#limits.maxFrameBytes) ||
      this.#limits.maxFrameBytes < 1 ||
      !Number.isSafeInteger(this.#limits.maxDimension) ||
      this.#limits.maxDimension < 1
    )
      throw new RangeError('GPU preview request limits must be positive safe integers');
  }

  admit(request: GpuPreviewFrameRequest, nowMs = Date.now()): GpuPreviewAdmission {
    if (validateGpuPreviewFrameRequest(request, nowMs).length > 0)
      return { accepted: false, reason: 'invalid-request' };
    if (!this.authorize(request, nowMs)) return { accepted: false, reason: 'unauthorized' };
    if ((request.assetTokens?.length ?? 0) > this.#limits.maxAssetTokens)
      return { accepted: false, reason: 'asset-limit' };
    if ((request.assetTokens ?? []).some((asset) => asset.expiresAtMs <= nowMs))
      return { accepted: false, reason: 'expired-asset-token' };
    const lastRequestId = this.#lastRequestBySession.get(request.sessionId);
    if (lastRequestId !== undefined && request.requestId <= lastRequestId)
      return { accepted: false, reason: 'replayed-request' };
    const recent = (this.#requestTimesBySession.get(request.sessionId) ?? []).filter(
      (time) => nowMs - time < 1_000,
    );
    if (recent.length >= this.#limits.maxRequestsPerSecond)
      return { accepted: false, reason: 'rate-limit' };
    recent.push(nowMs);
    this.#requestTimesBySession.set(request.sessionId, recent);
    this.#lastRequestBySession.set(request.sessionId, request.requestId);
    return { accepted: true };
  }

  clear(sessionId?: string): void {
    if (sessionId === undefined) {
      this.#lastRequestBySession.clear();
      this.#requestTimesBySession.clear();
    } else {
      this.#lastRequestBySession.delete(sessionId);
      this.#requestTimesBySession.delete(sessionId);
    }
  }

  validateResponse(response: GpuPreviewFrameResponse): readonly string[] {
    const errors: string[] = [];
    if (response.protocolVersion !== WORKER_PROTOCOL_VERSION) errors.push('protocolVersion');
    if (response.sessionId.length === 0) errors.push('sessionId');
    if (!Number.isSafeInteger(response.requestId) || response.requestId < 0)
      errors.push('requestId');
    if (
      !Number.isSafeInteger(response.width) ||
      !Number.isSafeInteger(response.height) ||
      response.width < 1 ||
      response.height < 1 ||
      response.width > this.#limits.maxDimension ||
      response.height > this.#limits.maxDimension
    )
      errors.push('dimensions');
    if (response.bytes.byteLength > this.#limits.maxFrameBytes) errors.push('frameBytes');
    if (response.renderer !== 'hardware-gpu') errors.push('renderer');
    return errors;
  }
}

/** Latest-wins pending request queue for scrub/current-frame preview. */
export class LatestPreviewRequestQueue {
  #pending: GpuPreviewFrameRequest | undefined;

  offer(request: GpuPreviewFrameRequest): void {
    if (this.#pending === undefined || request.requestId >= this.#pending.requestId)
      this.#pending = request;
  }

  take(): GpuPreviewFrameRequest | undefined {
    const request = this.#pending;
    this.#pending = undefined;
    return request;
  }

  get pending(): GpuPreviewFrameRequest | undefined {
    return this.#pending;
  }
}
