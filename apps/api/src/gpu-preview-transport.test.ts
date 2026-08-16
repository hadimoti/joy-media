import { describe, expect, it } from 'vitest';
import { WORKER_PROTOCOL_VERSION, type GpuPreviewFrameRequest } from '@joy-media/job-protocol';
import { LocalControlPlane } from './control-plane.js';
import { GpuPreviewTransport } from './gpu-preview-transport.js';

const actor = { id: 'owner-1' };

async function readyTransport(now = 10_000) {
  const controlPlane = new LocalControlPlane();
  controlPlane.createProject(actor, 'project-1', 'Preview fixture');
  controlPlane.pairWorker(actor, 'worker-gpu');
  controlPlane.helloWorker('worker-gpu', ['render.preview.gpu'], [], now);
  return { controlPlane, transport: new GpuPreviewTransport(controlPlane), now };
}

function request(
  session: Awaited<ReturnType<GpuPreviewTransport['open']>>,
  requestId = 1,
): GpuPreviewFrameRequest {
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    capability: 'render.preview.gpu',
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    requestId,
    projectId: 'project-1',
    projectRevisionId: 'revision-1',
    compositionId: 'root',
    timeUs: 0,
    quality: 'quarter',
    deadlineMs: 1_000,
    noStore: true,
    frame: {
      version: 1,
      compositionId: 'root',
      timeUs: 0,
      viewport: { width: 320, height: 180, dpr: 1 },
      background: { r: 12, g: 16, b: 24, a: 255 },
      nodes: [
        {
          id: 'title',
          kind: 'text',
          text: 'JOY GPU',
          color: { r: 255, g: 255, b: 255, a: 255 },
          zIndex: 1,
          opacity: 1,
          transform: { translateX: 24, translateY: 30, scaleX: 1, scaleY: 1 },
        },
      ],
    },
  };
}

describe('ephemeral GPU preview transport', () => {
  it('selects a paired hardware Worker and relays a no-store current frame', async () => {
    const { transport, now } = await readyTransport();
    const session = await transport.open(actor, 'project-1', now + 1);
    const frame = request(session);
    transport.offer(actor, frame, now + 2);
    expect(transport.take('worker-gpu', now + 3)).toEqual(frame);
    transport.complete(
      'worker-gpu',
      {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        sessionId: session.sessionId,
        requestId: 1,
        renderer: 'hardware-gpu',
        quality: 'quarter',
        width: 80,
        height: 45,
        bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      },
      now + 4,
    );
    expect(transport.result(actor, session.sessionId, 1, now + 5)).toMatchObject({
      renderer: 'hardware-gpu',
      width: 80,
      height: 45,
    });
    expect(transport.result(actor, session.sessionId, 1, now + 6)).toBeUndefined();
  });

  it('fails closed for stale Workers, other owners, replayed requests, and forged responses', async () => {
    const { controlPlane, transport, now } = await readyTransport();
    await expect(transport.open(actor, 'project-1', now + 60_000)).rejects.toThrow(
      'no paired hardware GPU preview Worker',
    );
    controlPlane.helloWorker('worker-gpu', ['render.preview.gpu'], [], now + 60_000);
    const session = await transport.open(actor, 'project-1', now + 60_001);
    const frame = request(session);
    expect(() => transport.offer({ id: 'other' }, frame, now + 60_002)).toThrow(
      'GPU preview session denied',
    );
    transport.offer(actor, frame, now + 60_003);
    expect(() => transport.offer(actor, frame, now + 60_004)).toThrow('replayed-request');
    expect(() =>
      transport.complete(
        'worker-other',
        {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          sessionId: session.sessionId,
          requestId: 1,
          renderer: 'hardware-gpu',
          quality: 'quarter',
          width: 80,
          height: 45,
          bytes: new Uint8Array([1]),
        },
        now + 60_005,
      ),
    ).toThrow('unknown GPU preview request');
    expect(() =>
      transport.complete(
        'worker-gpu',
        {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          sessionId: session.sessionId,
          requestId: 1,
          renderer: 'hardware-gpu',
          quality: 'full',
          width: 320,
          height: 180,
          bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        },
        now + 60_006,
      ),
    ).toThrow('request mismatch');
  });
});
