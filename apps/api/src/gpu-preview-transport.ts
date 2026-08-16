import { randomBytes, randomUUID } from 'node:crypto';
import {
  GpuPreviewRequestGate,
  LatestPreviewRequestQueue,
  type GpuPreviewFrameRequest,
  type GpuPreviewFrameResponse,
  type PreviewQuality,
} from '@joy-media/job-protocol';
import { ControlPlaneError, type Actor, type ControlPlane } from './control-plane.js';

export interface BrowserGpuPreviewSession {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly workerId: string;
  readonly expiresAtMs: number;
}

interface SessionState extends BrowserGpuPreviewSession {
  readonly projectId: string;
  readonly subject: string;
  readonly queue: LatestPreviewRequestQueue;
  readonly gate: GpuPreviewRequestGate;
  readonly responses: Map<number, GpuPreviewFrameResponse>;
  readonly offered: Map<
    number,
    { readonly quality: PreviewQuality; readonly width: number; readonly height: number }
  >;
}

const SESSION_TTL_MS = 5 * 60_000;
const WORKER_HEALTH_WINDOW_MS = 45_000;

/**
 * Ephemeral, latest-wins GPU preview relay. Requests and PNG frames live only
 * in memory and are never represented as durable Worker jobs.
 */
export class GpuPreviewTransport {
  readonly #sessions = new Map<string, SessionState>();

  constructor(private readonly controlPlane: ControlPlane) {}

  async open(
    actor: Actor,
    projectId: string,
    nowMs = Date.now(),
  ): Promise<BrowserGpuPreviewSession> {
    await this.controlPlane.getProject(actor, projectId);
    this.prune(nowMs);
    const worker = (await this.controlPlane.workersForOwner(actor))
      .filter(
        (candidate) =>
          candidate.paired &&
          !candidate.revoked &&
          candidate.capabilities.includes('render.preview.gpu') &&
          candidate.lastSeenAt !== undefined &&
          nowMs - candidate.lastSeenAt <= WORKER_HEALTH_WINDOW_MS,
      )
      .sort((left, right) => (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0))[0];
    if (worker === undefined)
      throw new ControlPlaneError(
        'GPU_PREVIEW_UNAVAILABLE',
        'no paired hardware GPU preview Worker is connected',
      );
    const sessionId = `preview-${randomUUID()}`;
    const sessionToken = randomBytes(32).toString('base64url');
    const expiresAtMs = nowMs + SESSION_TTL_MS;
    const state: SessionState = {
      sessionId,
      sessionToken,
      projectId,
      subject: actor.id,
      workerId: worker.id,
      expiresAtMs,
      queue: new LatestPreviewRequestQueue(),
      gate: new GpuPreviewRequestGate(
        { maxRequestsPerSecond: 30, maxAssetTokens: 64, maxFrameBytes: 16 * 1024 * 1024 },
        (request, at) =>
          request.sessionId === sessionId &&
          request.sessionToken === sessionToken &&
          request.projectId === projectId &&
          at < expiresAtMs,
      ),
      responses: new Map(),
      offered: new Map(),
    };
    this.#sessions.set(sessionId, state);
    return { sessionId, sessionToken, workerId: worker.id, expiresAtMs };
  }

  offer(actor: Actor, request: GpuPreviewFrameRequest, nowMs = Date.now()): void {
    const session = this.browserSession(actor, request.sessionId, nowMs);
    const admission = session.gate.admit(request, nowMs);
    if (!admission.accepted)
      throw new ControlPlaneError(
        'GPU_PREVIEW_REQUEST_REJECTED',
        admission.reason ?? 'GPU preview request rejected',
      );
    session.queue.offer(request);
    const scale = request.quality === 'quarter' ? 0.25 : request.quality === 'half' ? 0.5 : 1;
    session.offered.set(request.requestId, {
      quality: request.quality,
      width: Math.max(1, Math.round(request.frame.viewport.width * scale)),
      height: Math.max(1, Math.round(request.frame.viewport.height * scale)),
    });
    for (const requestId of session.responses.keys())
      if (requestId < request.requestId) session.responses.delete(requestId);
  }

  take(workerId: string, nowMs = Date.now()): GpuPreviewFrameRequest | undefined {
    this.prune(nowMs);
    const candidates = [...this.#sessions.values()]
      .filter((session) => session.workerId === workerId && session.queue.pending !== undefined)
      .sort(
        (left, right) =>
          (right.queue.pending?.requestId ?? -1) - (left.queue.pending?.requestId ?? -1),
      );
    return candidates[0]?.queue.take();
  }

  complete(workerId: string, response: GpuPreviewFrameResponse, nowMs = Date.now()): void {
    const session = this.#sessions.get(response.sessionId);
    const expected = session?.offered.get(response.requestId);
    if (
      session === undefined ||
      session.workerId !== workerId ||
      session.expiresAtMs <= nowMs ||
      expected === undefined
    )
      throw new ControlPlaneError('GPU_PREVIEW_RESPONSE_REJECTED', 'unknown GPU preview request');
    const errors = [...session.gate.validateResponse(response)];
    if (
      response.quality !== expected.quality ||
      response.width !== expected.width ||
      response.height !== expected.height
    )
      errors.push('request mismatch');
    if (!hasPngSignature(response.bytes)) errors.push('png signature');
    if (errors.length > 0)
      throw new ControlPlaneError(
        'GPU_PREVIEW_RESPONSE_REJECTED',
        `invalid GPU preview response: ${errors.join(', ')}`,
      );
    session.responses.set(response.requestId, response);
    session.offered.delete(response.requestId);
  }

  result(
    actor: Actor,
    sessionId: string,
    requestId: number,
    nowMs = Date.now(),
  ): GpuPreviewFrameResponse | undefined {
    const session = this.browserSession(actor, sessionId, nowMs);
    const result = session.responses.get(requestId);
    if (result !== undefined) session.responses.delete(requestId);
    return result;
  }

  close(actor: Actor, sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    if (session.subject !== actor.id)
      throw new ControlPlaneError('GPU_PREVIEW_SESSION_DENIED', 'GPU preview session denied');
    this.#sessions.delete(sessionId);
  }

  private browserSession(actor: Actor, sessionId: string, nowMs: number): SessionState {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.expiresAtMs <= nowMs || session.subject !== actor.id)
      throw new ControlPlaneError('GPU_PREVIEW_SESSION_DENIED', 'GPU preview session denied');
    return session;
  }

  private prune(nowMs: number): void {
    for (const [sessionId, session] of this.#sessions)
      if (session.expiresAtMs <= nowMs) this.#sessions.delete(sessionId);
  }
}

function hasPngSignature(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return (
    bytes.byteLength >= signature.length && signature.every((byte, index) => bytes[index] === byte)
  );
}

export interface SerializedGpuPreviewFrameResponse {
  readonly protocolVersion: 1;
  readonly sessionId: string;
  readonly requestId: number;
  readonly renderer: 'hardware-gpu';
  readonly quality: PreviewQuality;
  readonly width: number;
  readonly height: number;
  readonly bytesBase64: string;
}

export function deserializeGpuPreviewResponse(
  value: SerializedGpuPreviewFrameResponse,
): GpuPreviewFrameResponse {
  return {
    protocolVersion: value.protocolVersion,
    sessionId: value.sessionId,
    requestId: value.requestId,
    renderer: value.renderer,
    quality: value.quality,
    width: value.width,
    height: value.height,
    bytes: new Uint8Array(Buffer.from(value.bytesBase64, 'base64')),
  };
}
