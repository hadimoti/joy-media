import type { Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalControlPlane } from './control-plane.js';
import { createControlPlaneHttpServer, type ApiAuthentication } from './http-server.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
});

describe('control-plane HTTP transport', () => {
  it('keeps health public while rejecting versioned routes without an authenticated actor', async () => {
    const origin = await start({ authenticate: () => undefined });

    expect(await request(origin, 'GET', '/health')).toMatchObject({
      status: 200,
      body: { ok: true, controlPlane: true },
    });
    expect(
      await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' }),
    ).toMatchObject({
      status: 401,
      body: { error: { code: 'AUTH_REQUIRED' } },
    });
  });

  it('preserves project, Worker lease, completion, and cursor event semantics over v1', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });

    expect(
      await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' }),
    ).toMatchObject({
      status: 201,
      body: { data: { id: 'p', revision: 0 } },
    });
    expect(
      await request(origin, 'POST', '/v1/worker-pair/offers', {
        workerId: 'w',
        pairingCode: 'pairing-code',
      }),
    ).toMatchObject({ status: 201, body: { data: { workerId: 'w' } } });
    expect(
      await request(origin, 'POST', '/v1/workers/w/pair', { pairingCode: 'pairing-code' }),
    ).toMatchObject({ status: 200, body: { data: { id: 'w', paired: false, revoked: false } } });
    const claim = await request(origin, 'POST', '/v1/worker-pair/claim', {
      workerId: 'w',
      pairingCode: 'pairing-code',
    });
    expect(claim).toMatchObject({ status: 201, body: { data: { workerId: 'w' } } });
    const workerToken = (claim.body as { data: { sessionToken: string } }).data.sessionToken;
    expect(
      await request(
        origin,
        'POST',
        '/v1/workers/w/hello',
        { capabilities: ['asset.thumbnail'] },
        workerToken,
      ),
    ).toMatchObject({
      status: 200,
      body: { data: { id: 'w', capabilities: ['asset.thumbnail'] } },
    });
    expect(
      await request(origin, 'POST', '/v1/projects/p/jobs', { id: 'j', type: 'fixture.thumbnail' }),
    ).toMatchObject({
      status: 201,
      body: { data: { id: 'j', state: 'queued' } },
    });
    expect(await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken)).toMatchObject({
      status: 200,
      body: { data: { id: 'j', state: 'leased', leaseOwner: 'w' } },
    });
    expect(
      await request(
        origin,
        'POST',
        '/v1/workers/w/jobs/j/heartbeat',
        { progress: 50 },
        workerToken,
      ),
    ).toMatchObject({
      status: 200,
      body: { data: { cancelRequested: false, job: { progress: 50 } } },
    });
    expect(await request(origin, 'POST', '/v1/projects/p/jobs/j/cancel', {})).toMatchObject({
      status: 200,
      body: { data: { cancelRequested: true } },
    });
    expect(
      await request(
        origin,
        'POST',
        '/v1/workers/w/jobs/j/heartbeat',
        { progress: 60 },
        workerToken,
      ),
    ).toMatchObject({ status: 200, body: { data: { cancelRequested: true } } });
    expect(
      await request(
        origin,
        'POST',
        '/v1/workers/w/jobs/j/fail',
        { error: 'canceled' },
        workerToken,
      ),
    ).toMatchObject({ status: 200, body: { data: { state: 'canceled' } } });
    expect(await request(origin, 'POST', '/v1/projects/p/jobs/j/retry', {})).toMatchObject({
      status: 200,
      body: { data: { state: 'queued', progress: 0 } },
    });
    await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken);
    const completion = await request(
      origin,
      'POST',
      '/v1/workers/w/jobs/j/complete',
      {
        result: {
          kind: 'fixture.thumbnail',
          sha256: '78bf4c43aa7ab3a14c9f1e34f3333f9f612a08191affba3fb9c3e6de88378735',
          bytes: 14,
        },
      },
      workerToken,
    );
    expect(completion).toMatchObject({
      status: 200,
      body: {
        data: {
          id: 'j',
          state: 'completed',
          progress: 100,
          derivative: {
            jobId: 'j',
            kind: 'fixture.thumbnail',
            bytes: 14,
            workerRef: 'w',
            resultRef: 'derivative:j',
          },
        },
      },
    });
    const serializedCompletion = JSON.stringify(completion.body);
    expect(serializedCompletion).not.toMatch(/path|pairing|session|access_token|\\bbytesData\\b/i);
    expect(await request(origin, 'GET', '/v1/projects/p/jobs')).toMatchObject({
      status: 200,
      body: { data: [{ id: 'j', state: 'completed' }] },
    });
    const events = await request(origin, 'GET', '/v1/projects/p/events?cursor=0');
    expect(events.status).toBe(200);
    expect(
      (events.body as { data: readonly { type: string }[] }).data.map((event) => event.type),
    ).toEqual(expect.arrayContaining(['queued', 'cancel-requested', 'retried', 'completed']));
    expect(await request(origin, 'POST', '/v1/workers/w/revoke', {})).toMatchObject({
      status: 200,
      body: { data: { id: 'w', revoked: true } },
    });
    expect(await request(origin, 'GET', '/v1/workers')).toMatchObject({
      status: 200,
      body: { data: [{ id: 'w', revoked: true }] },
    });
    expect(await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken)).toMatchObject({
      status: 401,
      body: { error: { code: 'WORKER_SESSION_REQUIRED' } },
    });
  });
});

async function start(authentication: ApiAuthentication): Promise<string> {
  const server = createControlPlaneHttpServer({
    controlPlane: new LocalControlPlane(),
    authentication,
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test API did not bind TCP');
  return `http://127.0.0.1:${address.port}`;
}

async function request(
  origin: string,
  method: string,
  pathname: string,
  body?: Record<string, unknown>,
  bearerToken?: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (bearerToken !== undefined) headers.authorization = `Bearer ${bearerToken}`;
  const response = await fetch(
    `${origin}${pathname}`,
    body === undefined ? { method } : { method, headers, body: JSON.stringify(body) },
  );
  return { status: response.status, body: await response.json() };
}
