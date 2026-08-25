import type { Server } from 'node:http';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createControlPlaneHttpServer, LocalControlPlane } from '@joy-media/api';
import { WorkerControlPlaneClient } from './control-plane-client.js';

const stubMediaAuth = {
  requestOtp: async () => ({ message: 'stub' }),
  verifyOtp: async () => 'stub-token',
  logout: async () => {},
  authenticate: async (_req: IncomingMessage) => undefined,
  sessionProfile: async (_req: IncomingMessage) => undefined,
  avatarBytes: async (_req: IncomingMessage) => undefined,
};

describe('WorkerControlPlaneClient', () => {
  it('uses a Worker-only session after the owner approves a pairing offer', async () => {
    const requests: Array<{ readonly pathname: string; readonly authorization?: string }> = [];
    let session: string | undefined;
    const client = new WorkerControlPlaneClient({
      apiUrl: 'https://media.joyteam.ir/',
      identity: { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      sessionStore: {
        loadWorkerSession: () => session,
        saveWorkerSession: (value) => {
          session = value;
        },
        clearWorkerSession: () => {
          session = undefined;
        },
      },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const authorization = new Headers(init?.headers).get('authorization') ?? undefined;
        requests.push({
          pathname: url.pathname,
          ...(authorization === undefined ? {} : { authorization }),
        });
        if (url.pathname === '/v1/worker-pair/offers')
          return response(201, { data: { workerId: 'worker-1', expiresAt: 1_700_000_300_000 } });
        if (url.pathname === '/v1/worker-pair/claim')
          return response(201, {
            data: {
              workerId: 'worker-1',
              expiresAt: 1_700_000_300_000,
              sessionToken: 'worker-session',
            },
          });
        if (url.pathname.endsWith('/leases'))
          return response(200, {
            data: { id: 'job-1', projectId: 'project-1', type: 'asset.thumbnail' },
          });
        if (url.pathname.endsWith('/complete')) return response(200, { data: { id: 'job-1' } });
        return response(404, { error: {} });
      },
    });

    await expect(client.publishPairingOffer('pairing-code')).resolves.toBe(1_700_000_300_000);
    await expect(client.claimPairing('pairing-code')).resolves.toBe(true);
    await expect(client.lease()).resolves.toEqual({
      id: 'job-1',
      projectId: 'project-1',
      type: 'asset.thumbnail',
    });
    await client.complete('job-1', realThumbnailReceipt());

    expect(requests).toEqual([
      { pathname: '/v1/worker-pair/offers' },
      { pathname: '/v1/worker-pair/claim' },
      { pathname: '/v1/workers/worker-1/leases', authorization: 'Bearer worker-session' },
      {
        pathname: '/v1/workers/worker-1/jobs/job-1/complete',
        authorization: 'Bearer worker-session',
      },
    ]);
  });

  it('does not save a session until the pairing offer is approved', async () => {
    let saved = false;
    const client = new WorkerControlPlaneClient({
      apiUrl: 'https://media.joyteam.ir',
      identity: { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      sessionStore: {
        loadWorkerSession: () => undefined,
        saveWorkerSession: () => {
          saved = true;
        },
        clearWorkerSession: () => undefined,
      },
      fetch: async () => response(403, { error: { code: 'PAIRING_CLAIM_DENIED' } }),
    });

    await expect(client.claimPairing('pairing-code')).resolves.toBe(false);
    expect(saved).toBe(false);
  });

  it('uploads render.export bytes on the artifact route with receipt-bound headers', async () => {
    const requests: Array<{
      readonly pathname: string;
      readonly headers: Headers;
      readonly body: Uint8Array;
    }> = [];
    let session: string | undefined = 'worker-session';
    const client = new WorkerControlPlaneClient({
      apiUrl: 'https://media.joyteam.ir/api',
      identity: { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      sessionStore: {
        loadWorkerSession: () => session,
        saveWorkerSession: () => undefined,
        clearWorkerSession: () => {
          session = undefined;
        },
      },
      fetch: async (input, init) => {
        requests.push({
          pathname: new URL(String(input)).pathname,
          headers: new Headers(init?.headers),
          body: new Uint8Array((init?.body as Uint8Array) ?? []),
        });
        return response(201, { data: {} });
      },
    });
    const bytes = new Uint8Array([1, 2, 3]);
    await client.uploadRenderArtifact(
      'job-1',
      {
        kind: 'render.export',
        outputRef: 'render-job-1-aaaaaaaaaaaaaaaa',
        sha256: 'a'.repeat(64),
        bytes: bytes.length,
      },
      bytes,
    );
    expect(requests[0]?.pathname).toBe('/api/v1/workers/worker-1/jobs/job-1/artifact');
    expect(requests[0]?.headers.get('content-type')).toBe('video/mp4');
    expect(requests[0]?.headers.get('x-joy-output-ref')).toBe('render-job-1-aaaaaaaaaaaaaaaa');
    expect(requests[0]?.body).toEqual(bytes);
  });

  it('clears a revoked Worker session after a 401 response', async () => {
    let session: string | undefined = 'revoked-session';
    const client = new WorkerControlPlaneClient({
      apiUrl: 'https://media.joyteam.ir',
      identity: { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      sessionStore: {
        loadWorkerSession: () => session,
        saveWorkerSession: () => undefined,
        clearWorkerSession: () => {
          session = undefined;
        },
      },
      fetch: async () => response(401, { error: { code: 'WORKER_SESSION_REQUIRED' } }),
    });

    await expect(client.lease()).rejects.toThrow('Worker session expired or was revoked');
    expect(session).toBeUndefined();
  });

  it('preserves typed job payload metadata from leased jobs', async () => {
    const client = new WorkerControlPlaneClient({
      apiUrl: 'https://media.joyteam.ir',
      identity: { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      sessionStore: {
        loadWorkerSession: () => 'worker-session',
        saveWorkerSession: () => undefined,
        clearWorkerSession: () => undefined,
      },
      fetch: async () =>
        response(200, {
          data: {
            id: 'render-export-1',
            projectId: 'project-1',
            type: 'render.export',
            payload: {
              projectRef: 'project-ref-1',
              compositionId: 'composition-main',
              presetId: 'reels-1080',
              reportRef: 'report-render-export-1',
            },
            requirements: { capabilities: ['render.export'], privacy: 'local-only' },
            idempotencyKey: 'idem-render-export-1',
            maxAttempts: 5,
          },
        }),
    });

    await expect(client.lease()).resolves.toMatchObject({
      id: 'render-export-1',
      payload: {
        projectRef: 'project-ref-1',
        compositionId: 'composition-main',
        presetId: 'reels-1080',
        reportRef: 'report-render-export-1',
      },
      requirements: { capabilities: ['render.export'], privacy: 'local-only' },
      idempotencyKey: 'idem-render-export-1',
      maxAttempts: 5,
    });
  });

  it('pairs and completes a job over the real versioned HTTP transport', async () => {
    const server = createControlPlaneHttpServer({
      controlPlane: new LocalControlPlane(),
      authentication: { authenticate: () => ({ id: 'joy-user-1' }) },
      mediaAuth: stubMediaAuth,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('test API did not bind TCP');
      const apiUrl = `http://127.0.0.1:${address.port}`;
      let session: string | undefined;
      const client = new WorkerControlPlaneClient({
        apiUrl,
        identity: { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
        sessionStore: {
          loadWorkerSession: () => session,
          saveWorkerSession: (value) => {
            session = value;
          },
          clearWorkerSession: () => {
            session = undefined;
          },
        },
      });
      const pairingCode = 'pairing-code';
      await client.publishPairingOffer(pairingCode);
      expect(
        await post(apiUrl, '/v1/workers/worker-1/pair', { pairingCode }, 'joy-assertion'),
      ).toMatchObject({ status: 200 });
      expect(await client.claimPairing(pairingCode)).toBe(true);
      await client.hello(['asset.thumbnail'], ['asset-1']);
      await post(apiUrl, '/v1/projects', { id: 'project-1', title: 'Reference' }, 'joy-assertion');
      await post(
        apiUrl,
        '/v1/projects/project-1/assets',
        {
          id: 'asset-1',
          kind: 'video',
          displayName: 'clip.mp4',
          sha256: 'a'.repeat(64),
          bytes: 1024,
          descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000, width: 320, height: 180 },
          locations: [{ kind: 'opfs-cache', ref: 'opfs-a1' }],
        },
        'joy-assertion',
      );
      await post(
        apiUrl,
        '/v1/projects/project-1/jobs',
        { id: 'job-1', type: 'asset.thumbnail', assetId: 'asset-1' },
        'joy-assertion',
      );
      await expect(client.lease()).resolves.toMatchObject({ id: 'job-1' });
      await expect(client.complete('job-1', realThumbnailReceipt())).resolves.toBeUndefined();
    } finally {
      await close(server);
    }
  });
});

function response(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function realThumbnailReceipt() {
  return {
    kind: 'asset.thumbnail' as const,
    assetId: 'asset-1',
    sha256: 'a'.repeat(64),
    bytes: 1024,
    localRef: 'thumb-job-1-aaaaaaaaaaaaaaaa',
    descriptor: { mimeType: 'image/jpeg' as const, width: 320, height: 180 },
  };
}

async function post(
  apiUrl: string,
  pathname: string,
  body: Record<string, unknown>,
  bearerToken: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${apiUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearerToken}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
