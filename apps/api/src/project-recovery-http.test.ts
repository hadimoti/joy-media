import type { Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalControlPlane } from './control-plane.js';
import { DisabledMediaAuth } from './media-auth.js';
import { createControlPlaneHttpServer } from './http-server.js';

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

describe('recovered-copy HTTP transport', () => {
  it('parses operations and exposes typed validation/authorization errors', async () => {
    const controlPlane = new LocalControlPlane();
    const owner = { id: 'http-recovery-owner' };
    controlPlane.createProject(owner, 'http-source', 'Source');
    await controlPlane.appendProjectRevision(owner, 'http-source', {
      baseRevision: 0,
      idempotencyKey: 'http-source-1',
      document: { schemaVersion: 2, projectId: 'http-source', title: 'One' },
    });
    await controlPlane.appendProjectRevision(owner, 'http-source', {
      baseRevision: 1,
      idempotencyKey: 'http-source-2',
      document: { schemaVersion: 2, projectId: 'http-source', title: 'Two' },
    });
    const server = createControlPlaneHttpServer({
      controlPlane,
      authentication: { authenticate: () => owner },
      mediaAuth: new DisabledMediaAuth(),
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const origin = `http://127.0.0.1:${address.port}`;
    const invalid = await fetch(`${origin}/v2/projects/http-source/recovered-copies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: 1, idempotencyKey: 'bad', suggestedName: 'Copy' }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: 'REQUEST_INVALID' } });
    const unsafeAsset = await fetch(`${origin}/v2/projects/http-source/recovered-copies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: 1,
        idempotencyKey: 'bad-storage-ref',
        suggestedName: 'Unsafe Copy',
        operation: {
          kind: 'append',
          document: {
            schemaVersion: 2,
            projectId: 'old',
            assets: {
              image: {
                assetRef: 'opaque-asset-id',
                locations: [{ kind: 'private-object', ref: 'private-object-key' }],
              },
            },
          },
        },
      }),
    });
    expect(unsafeAsset.status).toBe(400);
    await expect(unsafeAsset.json()).resolves.toMatchObject({
      error: { code: 'REQUEST_INVALID' },
    });
    const created = await fetch(`${origin}/v2/projects/http-source/recovered-copies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: 1,
        idempotencyKey: 'http-recover-1',
        suggestedName: 'HTTP Copy',
        operation: { kind: 'append', document: { schemaVersion: 2, projectId: 'old' } },
      }),
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      data: { kind: 'recovered-copy', name: 'HTTP Copy', serverRevision: 1 },
    });
  });

  it('returns conflict for non-stale recovery and hides duplicate ownership over HTTP', async () => {
    const controlPlane = new LocalControlPlane();
    const owner = { id: 'http-stale-owner' };
    controlPlane.createProject(owner, 'http-stale-source', 'Source');
    const server = createControlPlaneHttpServer({
      controlPlane,
      authentication: {
        authenticate: (request) => ({
          id:
            typeof request.headers['x-owner-id'] === 'string'
              ? request.headers['x-owner-id']
              : owner.id,
        }),
      },
      mediaAuth: new DisabledMediaAuth(),
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const origin = `http://127.0.0.1:${address.port}`;
    const body = {
      baseRevision: 0,
      idempotencyKey: 'http-empty-recovery',
      suggestedName: 'Copy',
      operation: { kind: 'append', document: { schemaVersion: 2, projectId: 'old' } },
    };
    const empty = await fetch(`${origin}/v2/projects/http-stale-source/recovered-copies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(empty.status).toBe(409);
    await controlPlane.appendProjectRevision(owner, 'http-stale-source', {
      baseRevision: 0,
      idempotencyKey: 'http-stale-source-1',
      document: { schemaVersion: 2, projectId: 'http-stale-source' },
    });
    const future = await fetch(`${origin}/v2/projects/http-stale-source/recovered-copies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, idempotencyKey: 'http-future', baseRevision: 2 }),
    });
    expect(future.status).toBe(409);
    const sameOwnerDuplicate = await fetch(`${origin}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'http-stale-source', title: 'Other' }),
    });
    expect(sameOwnerDuplicate.status).toBe(409);
    const otherOwnerDuplicate = await fetch(`${origin}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-owner-id': 'http-other-owner' },
      body: JSON.stringify({ id: 'http-stale-source', title: 'Other' }),
    });
    expect(otherOwnerDuplicate.status).toBe(409);
    await expect(otherOwnerDuplicate.json()).resolves.toMatchObject({
      error: { code: 'PROJECT_NOT_FOUND' },
    });
  });
});
