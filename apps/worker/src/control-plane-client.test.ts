import type { Server } from 'node:http';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createControlPlaneHttpServer, LocalControlPlane } from '@joy-media/api';
import { WorkerControlPlaneClient, WorkerSessionExpiredError } from './control-plane-client.js';
import type { WorkerRequestTimeoutError } from './control-plane-client.js';

const stubMediaAuth = {
  requestOtp: async () => ({ message: 'stub' }),
  verifyOtp: async () => 'stub-token',
  logout: async () => {},
  authenticate: async (_req: IncomingMessage) => undefined,
  sessionProfile: async (_req: IncomingMessage) => undefined,
  avatarBytes: async (_req: IncomingMessage) => undefined,
};

describe('WorkerControlPlaneClient', () => {
  it('asks the desktop for one AI completion on a held job and returns only the reply text', async () => {
    const requests: { url: string; body: unknown; auth: string | null }[] = [];
    const client = new WorkerControlPlaneClient({
      apiUrl: 'http://127.0.0.1:4000',
      identity: { workerId: 'worker-1', createdAt: '2026-10-28T00:00:00.000Z' },
      sessionStore: {
        loadWorkerSession: () => 'local-token',
        clearWorkerSession: () => undefined,
      },
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
          auth: new Headers(init?.headers).get('authorization'),
        });
        return response(200, { data: { text: '{"choices":[]}' } });
      },
    });

    const text = await client.completeAi('job-1', 'lease-1', {
      messages: [{ role: 'user', content: 'hi' }],
      params: { temperature: 0.2 },
    });

    expect(text).toBe('{"choices":[]}');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://127.0.0.1:4000/v1/workers/worker-1/ai/complete');
    expect(requests[0]?.auth).toBe('Bearer local-token');
    expect(requests[0]?.body).toEqual({
      jobId: 'job-1',
      leaseToken: 'lease-1',
      messages: [{ role: 'user', content: 'hi' }],
      params: { temperature: 0.2 },
    });
  });

  it('refuses an AI reply that carries no text', async () => {
    const client = new WorkerControlPlaneClient({
      apiUrl: 'http://127.0.0.1:4000',
      identity: { workerId: 'worker-1', createdAt: '2026-10-28T00:00:00.000Z' },
      sessionStore: {
        loadWorkerSession: () => 'local-token',
        clearWorkerSession: () => undefined,
      },
      fetch: async () => response(200, { data: { unexpected: true } }),
    });

    await expect(client.completeAi('job-1', 'lease-1', { messages: [] })).rejects.toThrow(
      'The desktop returned an unreadable AI reply',
    );
  });

  it('clears a revoked Worker session after a 401 response', async () => {
    let session: string | undefined = 'revoked-session';
    const client = new WorkerControlPlaneClient({
      apiUrl: 'https://media.joyteam.ir',
      identity: { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      sessionStore: {
        loadWorkerSession: () => session,
        clearWorkerSession: () => {
          session = undefined;
        },
      },
      fetch: async () => response(401, { error: { code: 'WORKER_SESSION_REQUIRED' } }),
    });

    await expect(client.lease()).rejects.toThrow('Worker session expired or was revoked');
    expect(session).toBeUndefined();
  });

  it('clears a revoked Worker session when a proxy returns a non-JSON 401', async () => {
    let session: string | undefined = 'revoked-session';
    const client = new WorkerControlPlaneClient({
      apiUrl: 'https://media.joyteam.ir',
      identity: { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      sessionStore: {
        loadWorkerSession: () => session,
        clearWorkerSession: () => {
          session = undefined;
        },
      },
      fetch: async () =>
        new Response('<html>unauthorized</html>', {
          status: 401,
          headers: { 'content-type': 'text/html' },
        }),
    });

    await expect(client.lease()).rejects.toBeInstanceOf(WorkerSessionExpiredError);
    expect(session).toBeUndefined();
  });

  it('aborts and rejects a control-plane request that exceeds its deadline', async () => {
    let aborted = false;
    const client = new WorkerControlPlaneClient({
      apiUrl: 'https://media.joyteam.ir',
      identity: { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      sessionStore: {
        loadWorkerSession: () => 'worker-session',
        clearWorkerSession: () => undefined,
      },
      requestTimeoutMs: 100,
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted by test'));
          });
        }),
    });

    await expect(client.lease()).rejects.toMatchObject({
      name: 'WorkerRequestTimeoutError',
      timeoutMs: 100,
    } satisfies Partial<WorkerRequestTimeoutError>);
    expect(aborted).toBe(true);
  });

  it('bounds a response body that stalls after headers arrive', async () => {
    const client = new WorkerControlPlaneClient({
      apiUrl: 'https://media.joyteam.ir',
      identity: { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      sessionStore: {
        loadWorkerSession: () => 'worker-session',
        clearWorkerSession: () => undefined,
      },
      requestTimeoutMs: 100,
      fetch: async () => new Response(new ReadableStream<Uint8Array>()),
    });

    await expect(client.lease()).rejects.toMatchObject({
      name: 'WorkerRequestTimeoutError',
      timeoutMs: 100,
    } satisfies Partial<WorkerRequestTimeoutError>);
  });

  it('gives an AI completion a longer deadline than a control call, so the desktop reports its own timeout', async () => {
    const client = new WorkerControlPlaneClient({
      apiUrl: 'https://media.joyteam.ir',
      identity: { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      sessionStore: {
        loadWorkerSession: () => 'worker-session',
        clearWorkerSession: () => undefined,
      },
      requestTimeoutMs: 100,
      fetch: async () => {
        // Slower than the control deadline, and well within the AI deadline.
        await new Promise((resolve) => setTimeout(resolve, 300));
        return response(200, { data: { text: 'a slow reply' } });
      },
    });

    await expect(client.completeAi('job-1', 'lease-1', { messages: [] })).resolves.toBe(
      'a slow reply',
    );
    await expect(client.lease()).rejects.toMatchObject({
      name: 'WorkerRequestTimeoutError',
      timeoutMs: 100,
    } satisfies Partial<WorkerRequestTimeoutError>);
  });

  it('rejects invalid request timeout configuration instead of allowing unbounded I/O', () => {
    expect(
      () =>
        new WorkerControlPlaneClient({
          apiUrl: 'https://media.joyteam.ir',
          identity: { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
          sessionStore: {
            loadWorkerSession: () => undefined,
            clearWorkerSession: () => undefined,
          },
          requestTimeoutMs: 0,
        }),
    ).toThrow('Worker request timeout must be between 100ms and 120000ms');
  });

  it('downloads the staged job source with the Worker lease token', async () => {
    let seenAuthorization: string | undefined;
    let seenLeaseToken: string | undefined;
    const client = new WorkerControlPlaneClient({
      apiUrl: 'https://media.joyteam.ir/',
      identity: { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      sessionStore: {
        loadWorkerSession: () => 'worker-session',
        clearWorkerSession: () => undefined,
      },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        seenAuthorization = new Headers(init?.headers).get('authorization') ?? undefined;
        seenLeaseToken = new Headers(init?.headers).get('x-joy-lease-token') ?? undefined;
        expect(url.pathname).toBe('/v1/workers/worker-1/jobs/job-1/source');
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        });
      },
    });

    await expect(client.downloadJobAsset('job-1', 'lease-1')).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(seenAuthorization).toBe('Bearer worker-session');
    expect(seenLeaseToken).toBe('lease-1');
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
