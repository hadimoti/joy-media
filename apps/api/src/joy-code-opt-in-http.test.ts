import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalControlPlane } from './control-plane.js';
import { createControlPlaneHttpServer } from './http-server.js';
import { DisabledMediaAuth } from './media-auth.js';
import { JOY_CODE_CONSENT_VERSION } from './joy-code-consent.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))))); });
async function start(controlPlane: LocalControlPlane, authenticate: () => { id: string } | undefined = () => ({ id: 'owner' })) {
  const server = createControlPlaneHttpServer({ controlPlane, authentication: { authenticate }, mediaAuth: new DisabledMediaAuth() });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('not listening');
  return `http://127.0.0.1:${address.port}`;
}
async function request(origin: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${origin}${path}`, { method, headers: { authorization: 'Bearer owner', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as unknown };
}

describe('Joy Code opt-in routes', () => {
  it('returns disabled by default and requires the current disclosure version', async () => {
    const controlPlane = new LocalControlPlane(); controlPlane.createProject({ id: 'owner' }, 'p', 'Project');
    const origin = await start(controlPlane);
    expect(await request(origin, 'GET', '/v1/projects/p/joy-code-opt-in')).toMatchObject({ status: 200, body: { data: { enabled: false, revision: 0 } } });
    expect(await request(origin, 'PUT', '/v1/projects/p/joy-code-opt-in', { enabled: true, consentVersion: 'old', baseRevision: 0 })).toMatchObject({ status: 409, body: { error: { code: 'JOY_CODE_CONSENT_VERSION_REQUIRED' } } });
    expect(await request(origin, 'PUT', '/v1/projects/p/joy-code-opt-in', { enabled: true, consentVersion: JOY_CODE_CONSENT_VERSION, baseRevision: 0 })).toMatchObject({ status: 200, body: { data: { enabled: true, revision: 1, consentVersion: JOY_CODE_CONSENT_VERSION } } });
  });
  it('rejects unauthenticated access and malformed bodies', async () => {
    const controlPlane = new LocalControlPlane(); controlPlane.createProject({ id: 'owner' }, 'p', 'Project');
    const origin = await start(controlPlane, () => undefined);
    expect(await request(origin, 'GET', '/v1/projects/p/joy-code-opt-in')).toMatchObject({ status: 401 });
  });
  it('orders Joy Code plan gates as opt-in then envelope then unavailable resolver', async () => {
    const controlPlane = new LocalControlPlane(); controlPlane.createProject({ id: 'owner' }, 'p', 'Project');
    const origin = await start(controlPlane);
    const envelope = { projectId: 'p', snapshotRevisionId: 'r', prompt: 'trim', selection: { clipIds: [] } };
    expect(await request(origin, 'POST', '/v1/projects/p/joy-code/plans', envelope)).toMatchObject({ status: 409, body: { error: { code: 'POLICY_DENIED' } } });
    await controlPlane.setJoyCodeOptIn({ id: 'owner' }, 'p', true, JOY_CODE_CONSENT_VERSION, 0);
    expect(await request(origin, 'POST', '/v1/projects/p/joy-code/plans', { ...envelope, snapshot: {} })).toMatchObject({ status: 400, body: { error: { code: 'REQUEST_INVALID' } } });
    expect(await request(origin, 'POST', '/v1/projects/p/joy-code/plans', envelope)).toMatchObject({ status: 503, body: { error: { code: 'JOY_CODE_INPUT_UNAVAILABLE' } } });
  });
});
