import { describe, expect, it } from 'vitest';
import { WORKER_PROTOCOL_VERSION } from './protocol.js';
import {
  GpuPreviewSessionBroker,
  GpuPreviewRequestGate,
  LatestPreviewRequestQueue,
  validateGpuPreviewFrameRequest,
  type GpuPreviewFrameRequest,
} from './preview.js';

const request = (requestId: number): GpuPreviewFrameRequest => ({
  protocolVersion: WORKER_PROTOCOL_VERSION,
  capability: 'render.preview.gpu',
  sessionId: 'session-1',
  requestId,
  projectId: 'project-1',
  projectRevisionId: 'rev-1',
  compositionId: 'root',
  timeUs: requestId * 1_000,
  quality: 'quarter',
  deadlineMs: 250,
});

describe('GPU preview request queue', () => {
  it('keeps only the newest pending scrub request', () => {
    const queue = new LatestPreviewRequestQueue();
    queue.offer(request(1));
    queue.offer(request(3));
    queue.offer(request(2));
    expect(queue.take()?.requestId).toBe(3);
    expect(queue.take()).toBeUndefined();
  });

  it('authorizes only the matching unexpired project session and supports revocation', () => {
    const broker = new GpuPreviewSessionBroker();
    const session = broker.open(
      { sessionId: 'session-1', projectId: 'project-1', subject: 'user-1', ttlMs: 5_000 },
      100,
    );
    expect(
      broker.authorize(
        {
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
          projectId: 'project-1',
        },
        1_000,
      ),
    ).toBe(true);
    expect(
      broker.authorize(
        { sessionId: session.sessionId, sessionToken: session.sessionToken, projectId: 'other' },
        1_000,
      ),
    ).toBe(false);
    broker.revoke(session.sessionId);
    expect(
      broker.authorize(
        {
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
          projectId: 'project-1',
        },
        1_000,
      ),
    ).toBe(false);
  });

  it('requires ephemeral authorization, no-store, bounded deadline, and live asset grants', () => {
    const errors = validateGpuPreviewFrameRequest(
      {
        ...request(1),
        sessionToken: 'session-token',
        noStore: true,
        assetTokens: [{ assetId: 'asset-1', token: 'asset-token', expiresAtMs: 10_000 }],
        deadlineMs: 250,
      },
      1_000,
    );
    expect(errors).toEqual([]);
    expect(validateGpuPreviewFrameRequest({ ...request(2), deadlineMs: 20_000 }, 1_000)).toEqual(
      expect.arrayContaining(['session authorization', 'noStore', 'deadlineMs']),
    );
  });

  it('rejects replayed requests and enforces a per-session rate window', () => {
    const gate = new GpuPreviewRequestGate(
      { maxRequestsPerSecond: 2 },
      (candidate) => candidate.sessionToken === 'session-token',
    );
    const secure = (requestId: number): GpuPreviewFrameRequest => ({
      ...request(requestId),
      sessionToken: 'session-token',
      noStore: true,
    });
    expect(gate.admit(secure(1), 1_000)).toEqual({ accepted: true });
    expect(gate.admit(secure(1), 1_001)).toEqual({
      accepted: false,
      reason: 'replayed-request',
    });
    expect(gate.admit(secure(2), 1_002)).toEqual({ accepted: true });
    expect(gate.admit(secure(3), 1_003)).toEqual({
      accepted: false,
      reason: 'rate-limit',
    });
    expect(gate.admit(secure(3), 2_001)).toEqual({ accepted: true });
  });

  it('rejects oversized tokens and malformed hardware responses', () => {
    const gate = new GpuPreviewRequestGate({ maxAssetTokens: 1, maxFrameBytes: 4 });
    const secure = (
      assetTokens: GpuPreviewFrameRequest['assetTokens'],
    ): GpuPreviewFrameRequest => ({
      ...request(1),
      sessionToken: 'session-token',
      noStore: true,
      ...(assetTokens === undefined ? {} : { assetTokens }),
    });
    expect(
      gate.admit(
        secure([
          { assetId: 'a', token: 'a', expiresAtMs: 10_000 },
          { assetId: 'b', token: 'b', expiresAtMs: 10_000 },
        ]),
        1_000,
      ),
    ).toEqual({ accepted: false, reason: 'asset-limit' });
    expect(
      gate.validateResponse({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        sessionId: 'session-1',
        requestId: 1,
        renderer: 'hardware-gpu',
        quality: 'quarter',
        width: 8_192,
        height: 8_192,
        bytes: new Uint8Array(5),
      }),
    ).toEqual(expect.arrayContaining(['dimensions', 'frameBytes']));
  });
});
