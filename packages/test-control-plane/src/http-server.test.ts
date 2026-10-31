import { once } from 'node:events';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalControlPlane,
  MAX_WORKER_ATTEMPTS,
  type Actor,
  type ControlPlane,
  type MediaAssetRecord,
  type MediaDerivativeRecord,
} from './control-plane.js';
import {
  createControlPlaneHttpServer,
  DEFAULT_MAX_JSON_BODY_BYTES,
  type ApiAuthentication,
} from './http-server.js';
import { createClientAddressResolver, type ClientAddressResolver } from './client-address.js';
import {
  INITIAL_REVISION,
  MAX_PROJECT_DOCUMENT_SYNC_BYTES,
} from './project-document-sync-request-validation.js';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import type { PrivateObjectDescriptor, PrivateObjectStore } from './private-object-store.js';

const servers: Server[] = [];
const SHA256 = 'a'.repeat(64);

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
  it('keeps health public while requiring an authenticated actor for project routes', async () => {
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

  it('downloads a leased source asset through the Worker source route', async () => {
    const workerJob = await createLeasedWorkerJob();
    const response = await fetch(
      `${workerJob.origin}/v1/workers/${workerJob.workerId}/jobs/${workerJob.jobId}/source`,
      {
        headers: {
          authorization: `Bearer ${workerJob.workerToken}`,
          'x-joy-lease-token': workerJob.leaseToken,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(workerJob.sourceBytes);
  });

  it('uploads a derivative with 201 and keeps its object key stable for an exact retry', async () => {
    const workerJob = await createLeasedWorkerJob();
    const derivativeBytes = new Uint8Array([9, 8, 7, 6]);
    const sha256 = createHash('sha256').update(derivativeBytes).digest('hex');
    const headers = {
      authorization: `Bearer ${workerJob.workerToken}`,
      'content-type': 'video/mp4',
      'x-joy-asset-id': 'worker-source',
      'x-joy-sha256': sha256,
      'x-joy-bytes': String(derivativeBytes.byteLength),
      'x-joy-derivative-kind': 'proxy',
      'x-joy-width': '64',
      'x-joy-height': '36',
      'x-joy-duration-us': '100000',
      'x-joy-lease-token': workerJob.leaseToken,
    };

    const upload = async () =>
      fetch(
        `${workerJob.origin}/v1/workers/${workerJob.workerId}/jobs/${workerJob.jobId}/derivative`,
        {
          method: 'POST',
          headers,
          body: derivativeBytes.buffer.slice(
            derivativeBytes.byteOffset,
            derivativeBytes.byteOffset + derivativeBytes.byteLength,
          ) as ArrayBuffer,
        },
      );

    const first = await upload();
    const firstBody = await first.json();
    expect(first.status).toBe(201);
    expect(firstBody).toMatchObject({ data: { assetId: 'worker-source' } });
    const derivativeRefs = [...workerJob.objects.keys()].filter((ref) => ref !== 'source-object');
    expect(derivativeRefs).toHaveLength(1);

    const retry = await upload();
    expect(retry.status).toBe(201);
    expect([...workerJob.objects.keys()].filter((ref) => ref !== 'source-object')).toEqual(
      derivativeRefs,
    );
  });

  it('rejects a derivative with a mismatched byte length or missing lease token', async () => {
    const workerJob = await createLeasedWorkerJob();
    const derivativeBytes = new Uint8Array([9, 8, 7]);
    const sha256 = createHash('sha256').update(derivativeBytes).digest('hex');
    const headers = {
      authorization: `Bearer ${workerJob.workerToken}`,
      'content-type': 'video/mp4',
      'x-joy-asset-id': 'worker-source',
      'x-joy-sha256': sha256,
      'x-joy-bytes': '4',
      'x-joy-derivative-kind': 'proxy',
      'x-joy-width': '64',
      'x-joy-height': '36',
      'x-joy-duration-us': '100000',
      'x-joy-lease-token': workerJob.leaseToken,
    };
    const post = (requestHeaders: Record<string, string>) =>
      fetch(
        `${workerJob.origin}/v1/workers/${workerJob.workerId}/jobs/${workerJob.jobId}/derivative`,
        {
          method: 'POST',
          headers: requestHeaders,
          body: derivativeBytes.buffer.slice(
            derivativeBytes.byteOffset,
            derivativeBytes.byteOffset + derivativeBytes.byteLength,
          ) as ArrayBuffer,
        },
      );

    const wrongLength = await post(headers);
    expect(wrongLength.status).toBe(400);
    expect(await wrongLength.json()).toMatchObject({ error: { code: 'REQUEST_INVALID' } });

    const { 'x-joy-lease-token': _leaseToken, ...missingLeaseHeaders } = headers;
    const missingLease = await post({ ...missingLeaseHeaders, 'x-joy-bytes': '3' });
    expect(missingLease.status).toBe(400);
    expect(await missingLease.json()).toMatchObject({ error: { code: 'REQUEST_INVALID' } });
  });

  it('reports an unavailable private store for Worker source and derivative routes', async () => {
    const workerJob = await createLeasedWorkerJob({ withStore: false });
    const source = await fetch(
      `${workerJob.origin}/v1/workers/${workerJob.workerId}/jobs/${workerJob.jobId}/source`,
      {
        headers: {
          authorization: `Bearer ${workerJob.workerToken}`,
          'x-joy-lease-token': workerJob.leaseToken,
        },
      },
    );
    expect(source.status).toBe(503);
    expect(await source.json()).toMatchObject({
      error: { code: 'PRIVATE_STORE_UNAVAILABLE' },
    });

    const derivative = await fetch(
      `${workerJob.origin}/v1/workers/${workerJob.workerId}/jobs/${workerJob.jobId}/derivative`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${workerJob.workerToken}` },
        body: new Uint8Array([1]),
      },
    );
    expect(derivative.status).toBe(503);
    expect(await derivative.json()).toMatchObject({
      error: { code: 'PRIVATE_STORE_UNAVAILABLE' },
    });
  });
});

async function createLeasedWorkerJob(options: { readonly withStore?: boolean } = {}) {
  const owner = { id: 'owner-1' };
  const projectId = 'worker-project';
  const workerId = 'worker-1';
  const jobId = 'worker-job';
  const pairingCode = 'worker-pairing-code';
  const controlPlane = new LocalControlPlane();
  const sourceBytes = new Uint8Array([1, 2, 3, 4]);
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const objects = new Map<string, { descriptor: PrivateObjectDescriptor; bytes: Uint8Array }>();
  const store: PrivateObjectStore = {
    async put(descriptor, bytes) {
      objects.set(descriptor.ref, { descriptor, bytes: new Uint8Array(bytes) });
    },
    async get(descriptor) {
      const object = objects.get(descriptor.ref);
      if (object === undefined) throw new Error('test object is missing');
      return new Uint8Array(object.bytes);
    },
    async remove(ref) {
      objects.delete(ref);
    },
  };
  await controlPlane.createProject(owner, projectId, 'Worker route fixture');
  await controlPlane.registerAsset(owner, projectId, {
    id: 'worker-source',
    kind: 'video',
    displayName: 'source.mp4',
    sha256: sourceSha256,
    bytes: sourceBytes.byteLength,
    descriptor: { mimeType: 'video/mp4', width: 64, height: 36, durationUs: 100_000 },
    locations: [{ kind: 'private-object', ref: 'source-object' }],
  });
  if (options.withStore !== false) {
    await store.put(
      {
        ref: 'source-object',
        sha256: sourceSha256,
        bytes: sourceBytes.byteLength,
        mimeType: 'video/mp4',
      },
      sourceBytes,
    );
  }
  const origin = await start(
    { authenticate: () => owner },
    options.withStore === false ? undefined : store,
    undefined,
    controlPlane,
  );
  await request(origin, 'POST', '/v1/worker-pair/offers', { workerId, pairingCode });
  await request(origin, 'POST', `/v1/workers/${workerId}/pair`, { pairingCode });
  const claim = await request(origin, 'POST', '/v1/worker-pair/claim', { workerId, pairingCode });
  const workerToken = (claim.body as { data: { sessionToken: string } }).data.sessionToken;
  await controlPlane.helloWorker(workerId, ['render.export']);
  const now = Date.now();
  await controlPlane.enqueue(owner, jobId, projectId, 'render.export', now, 'worker-source', {
    schemaVersion: 1,
    producer: 'browser-staged-preview-export',
    frameCount: 3,
    manifest: {
      projectId,
      revision: 0,
      width: 64,
      height: 36,
      frameRate: 30,
      durationUs: 100_000,
      preset: 'reels-1080',
    },
  });
  const lease = await controlPlane.lease(workerId, now + 1);
  if (lease === undefined || lease.leaseToken === undefined)
    throw new Error('worker job was not leased');
  return {
    origin,
    workerId,
    jobId,
    workerToken,
    leaseToken: lease.leaseToken,
    sourceBytes,
    objects,
  };
}

function validProjectDocumentSyncEnvelope(
  projectId: string,
  baseRevisionId: string = INITIAL_REVISION,
  revisionId: string = 'rev-1',
): { baseRevisionId: string; revisionId: string; document: JoyProjectV1 } {
  return {
    baseRevisionId,
    revisionId,
    document: {
      schemaVersion: 1,
      id: projectId,
      title: 'Test Project',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      rootCompositionId: 'comp-1',
      settings: { defaultLocale: 'en' },
      compositions: {
        'comp-1': {
          id: 'comp-1',
          name: 'Root Composition',
          width: 1920,
          height: 1080,
          pixelAspectRatio: { num: 1, den: 1 },
          frameRate: { num: 30, den: 1 },
          durationUs: 10000000,
          background: '#00000000',
          tracks: [],
        },
      },
      assets: {},
      variables: {},
      markers: [],
      visualObjects: {},
      captionDocuments: {},
      pluginData: {},
    },
  };
}

async function start(
  authentication: ApiAuthentication,
  privateObjectStore?: PrivateObjectStore,
  _mistral?: unknown,
  controlPlane: ControlPlane = new LocalControlPlane(),
  _audioDenoise?: unknown,
  _creativeBriefInputResolver?: unknown,
  _creativeBriefRuntime?: unknown,
  rateLimit?: { readonly windowMs?: number; readonly maxRequests?: number },
  clientAddressResolver?: ClientAddressResolver,
): Promise<string> {
  const server = createControlPlaneHttpServer({
    controlPlane,
    authentication,
    ...(privateObjectStore === undefined ? {} : { privateObjectStore }),
    ...(rateLimit === undefined ? {} : { rateLimit }),
    ...(clientAddressResolver === undefined ? {} : { clientAddressResolver }),
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('test server did not bind TCP');
  return 'http://127.0.0.1:' + address.port;
}

async function request(
  origin: string,
  method: string,
  pathname: string,
  body?: Record<string, unknown>,
  bearerToken?: string,
  additionalHeaders?: Record<string, string>,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (bearerToken !== undefined) headers.authorization = 'Bearer ' + bearerToken;
  Object.assign(headers, additionalHeaders);
  const response = await fetch(
    origin + pathname,
    body === undefined
      ? { method, ...(Object.keys(headers).length === 0 ? {} : { headers }) }
      : { method, headers, body: JSON.stringify(body) },
  );
  return { status: response.status, body: await response.json() };
}

class UnsafeDescriptorControlPlane extends LocalControlPlane {
  override assetsForProject(actor: Actor, projectId: string): readonly MediaAssetRecord[] {
    return super.assetsForProject(actor, projectId).map((asset) => ({
      ...asset,
      descriptor: {
        ...asset.descriptor,
        animation: {
          frameCount: 1,
          cycleDurationUs: 1_000_000,
          loopCount: 0,
          hasAlpha: false,
          objectKey: 'private-key',
        },
        locations: [{ kind: 'private-object', ref: 'private-key' }],
        cloudRef: 'private-key',
        credentials: 'secret',
      } as MediaAssetRecord['descriptor'],
    }));
  }

  override derivativesForAsset(
    actor: Actor,
    projectId: string,
    assetId: string,
  ): readonly MediaDerivativeRecord[] {
    return super.derivativesForAsset(actor, projectId, assetId).map((derivative) => ({
      ...derivative,
      descriptor: {
        ...derivative.descriptor,
        objectKey: 'private-key',
      } as MediaDerivativeRecord['descriptor'],
    }));
  }
}
describe('control-plane HTTP transport', () => {
  it('keys the process rate limit by the trusted client address, not a spoofed header', async () => {
    const origin = await start(
      { authenticate: () => undefined },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { windowMs: 60_000, maxRequests: 1 },
      createClientAddressResolver({ trustedProxyAddresses: ['127.0.0.1'] }),
    );
    const first = await request(origin, 'GET', '/v1/projects/a', undefined, undefined, {
      'x-forwarded-for': '198.51.100.1',
    });
    const second = await request(origin, 'GET', '/v1/projects/a', undefined, undefined, {
      'x-forwarded-for': '198.51.100.2',
    });
    const repeated = await request(origin, 'GET', '/v1/projects/a', undefined, undefined, {
      'x-forwarded-for': '198.51.100.1',
    });
    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(repeated).toMatchObject({ status: 429, body: { error: { code: 'RATE_LIMITED' } } });
  });

  it('exposes the owner-authorized project lifecycle routes with revision and trash guards', async () => {
    const controlPlane = new LocalControlPlane();
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      undefined,
      controlPlane,
    );
    expect(
      await request(origin, 'POST', '/v1/projects/ensure', {
        id: 'ensured',
        title: 'Ensured project',
      }),
    ).toMatchObject({
      status: 200,
      body: { data: { id: 'ensured', revision: 0, title: 'Ensured project' } },
    });
    expect(
      await request(origin, 'POST', '/v1/projects/ensure', {
        id: 'ensured',
        title: 'Ignored after creation',
      }),
    ).toMatchObject({
      status: 200,
      body: { data: { id: 'ensured', revision: 0, title: 'Ensured project' } },
    });
    expect(
      await request(origin, 'POST', '/v1/projects', { id: 'source', title: 'Source' }),
    ).toMatchObject({ status: 201, body: { data: { revision: 0, title: 'Source' } } });
    await controlPlane.registerAsset({ id: 'owner' }, 'source', {
      id: 'source-asset',
      kind: 'video',
      displayName: 'clip.mp4',
      sha256: SHA256,
      bytes: 12,
      descriptor: { mimeType: 'video/mp4' },
      locations: [{ kind: 'private-object', ref: 'source-object' }],
    });
    expect(
      await request(origin, 'PATCH', '/v1/projects/source', {
        title: 'Renamed',
        baseRevision: 0,
      }),
    ).toMatchObject({ status: 200, body: { data: { revision: 1, title: 'Renamed' } } });
    expect(
      await request(origin, 'POST', '/v1/projects/source/duplicate', {
        id: 'copy',
        title: 'Renamed copy',
        baseRevision: 1,
      }),
    ).toMatchObject({
      status: 201,
      body: {
        data: { project: { id: 'copy' }, assetIdMap: { 'source-asset': expect.any(String) } },
      },
    });
    expect(
      await request(origin, 'POST', '/v1/projects/source/trash', { baseRevision: 1 }),
    ).toMatchObject({
      status: 200,
      body: { data: { trashedAt: expect.any(Number), revision: 2 } },
    });
    expect(await request(origin, 'GET', '/v1/projects/source')).toMatchObject({
      status: 200,
      body: { data: { trashedAt: expect.any(Number) } },
    });
    expect(
      await request(origin, 'POST', '/v1/projects/source/restore', { baseRevision: 2 }),
    ).toMatchObject({ status: 200, body: { data: { revision: 3 } } });
    expect(
      await request(origin, 'POST', '/v1/projects/source/trash', { baseRevision: 3 }),
    ).toMatchObject({ status: 200, body: { data: { revision: 4 } } });
    expect(await request(origin, 'DELETE', '/v1/projects/source')).toMatchObject({
      status: 200,
      body: { data: { id: 'source' } },
    });
    expect(await request(origin, 'GET', '/v1/projects/source')).toMatchObject({
      status: 409,
      body: { error: { code: 'PROJECT_NOT_FOUND' } },
    });
  });

  it('optionally scopes My Media catalog reads to one authorized project', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    for (const projectId of ['project-a', 'project-b']) {
      await request(origin, 'POST', '/v1/projects', { id: projectId, title: projectId });
      await request(origin, 'POST', `/v1/projects/${projectId}/assets`, {
        id: `asset-${projectId}`,
        kind: 'image',
        displayName: `${projectId}.png`,
        sha256: SHA256,
        bytes: 12,
        descriptor: { mimeType: 'image/png' },
        locations: [{ kind: 'opfs-cache', ref: `opfs-${projectId}` }],
      });
    }

    expect(await request(origin, 'GET', '/v1/library/my-assets')).toMatchObject({
      status: 200,
      body: { data: [{ id: 'asset-project-a' }, { id: 'asset-project-b' }] },
    });
    expect(await request(origin, 'GET', '/v1/library/my-assets?projectId=project-a')).toMatchObject(
      {
        status: 200,
        body: { data: [{ id: 'asset-project-a', projectId: 'project-a' }] },
      },
    );
  });

  it('associates a durable catalog asset before it is used by a project-scoped Worker job', async () => {
    const controlPlane = new LocalControlPlane();
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      undefined,
      controlPlane,
    );
    await request(origin, 'POST', '/v1/projects', { id: 'source', title: 'Source' });
    await request(origin, 'POST', '/v1/projects', { id: 'target', title: 'Target' });
    await controlPlane.registerAsset({ id: 'owner' }, 'source', {
      id: 'catalog-video',
      kind: 'video',
      displayName: 'catalog.mp4',
      sha256: SHA256,
      bytes: 12,
      descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000 },
      locations: [{ kind: 'private-object', ref: 'catalog-original' }],
    });

    expect(
      await request(origin, 'POST', '/v1/projects/target/assets/catalog-video/associate'),
    ).toMatchObject({
      status: 200,
      body: { data: { id: 'catalog-video', projectId: 'target', cloudBacked: true } },
    });
    expect(await request(origin, 'GET', '/v1/projects/target/assets')).toMatchObject({
      status: 200,
      body: { data: [{ id: 'catalog-video', projectId: 'target' }] },
    });
    expect(
      await request(origin, 'POST', '/v1/projects/target/jobs', {
        id: 'catalog-thumbnail-job',
        type: 'asset.thumbnail',
        assetId: 'catalog-video',
      }),
    ).toMatchObject({
      status: 201,
      body: { data: { projectId: 'target', assetId: 'catalog-video' } },
    });
  });

  it('strips storage-bearing descriptor fields from browser asset projections', async () => {
    const controlPlane = new UnsafeDescriptorControlPlane();
    await controlPlane.createProject({ id: 'owner' }, 'projection-project', 'Projection');
    await controlPlane.registerAsset({ id: 'owner' }, 'projection-project', {
      id: 'asset-1',
      kind: 'image',
      displayName: 'frame.jpg',
      sha256: SHA256,
      bytes: 10,
      descriptor: { mimeType: 'image/jpeg', width: 1, height: 1 },
      locations: [{ kind: 'opfs-cache', ref: 'opfs-a1' }],
    });
    await controlPlane.registerLocalDerivative({ id: 'owner' }, 'projection-project', {
      id: 'derivative-1',
      assetId: 'asset-1',
      kind: 'thumbnail',
      profile: 'jpeg-640',
      sha256: 'b'.repeat(64),
      bytes: 5,
      descriptor: { mimeType: 'image/jpeg', width: 1, height: 1 },
      availability: 'available-local',
      locations: [{ kind: 'opfs-cache', ref: 'opfs-d1' }],
    });
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      undefined,
      controlPlane,
    );
    const response = await request(origin, 'GET', '/v1/projects/projection-project/assets');
    expect(response).toMatchObject({
      status: 200,
      body: { data: [{ descriptor: { mimeType: 'image/jpeg', width: 1, height: 1 } }] },
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /locations|cloudRef|objectKey|credentials|private-key/,
    );
    const derivatives = await request(
      origin,
      'GET',
      '/v1/projects/projection-project/assets/asset-1/derivatives',
    );
    expect(derivatives).toMatchObject({
      status: 200,
      body: { data: [{ descriptor: { mimeType: 'image/jpeg', width: 1, height: 1 } }] },
    });
    expect(JSON.stringify(derivatives.body)).not.toMatch(/locations|objectKey|private-key/);
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
      await request(origin, 'POST', '/v1/projects/p/asset-sync', { enabled: true }),
    ).toMatchObject({
      status: 200,
      body: { data: { assetSyncEnabled: true } },
    });
    const asset = {
      id: 'asset-1',
      kind: 'video',
      displayName: 'clip.mp4',
      sha256: 'a'.repeat(64),
      bytes: 8_589_934_592,
      descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000, width: 1920, height: 1080 },
      locations: [{ kind: 'opfs-cache', ref: 'opfs-a1' }],
    };
    expect(await request(origin, 'POST', '/v1/projects/p/assets', asset)).toMatchObject({
      status: 201,
      body: { data: { id: 'asset-1', projectId: 'p', bytes: 8_589_934_592 } },
    });
    expect(
      await request(origin, 'POST', '/v1/projects/p/assets/asset-1/derivatives', {
        id: 'derivative-1',
        assetId: 'asset-1',
        kind: 'proxy',
        profile: 'h264-720p',
        sha256: 'b'.repeat(64),
        bytes: 1234,
        descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000, width: 1280, height: 720 },
        availability: 'available-local',
        locations: [{ kind: 'opfs-cache', ref: 'opfs-d1' }],
      }),
    ).toMatchObject({
      status: 201,
      body: { data: { id: 'derivative-1', availability: 'available-local' } },
    });
    const metadata = await request(origin, 'GET', '/v1/projects/p/assets/asset-1/derivatives');
    expect(metadata).toMatchObject({ status: 200, body: { data: [{ id: 'derivative-1' }] } });
    expect(JSON.stringify(metadata.body)).not.toMatch(
      /path|locations|opfs-|pairing|session|access_token|https?:\/\//i,
    );
    expect(
      await request(origin, 'POST', '/v1/projects/p/assets', {
        ...asset,
        id: 'asset-unsafe',
        displayName: 'C:\\Users\\Hadi\\clip.mp4',
      }),
    ).toMatchObject({ status: 409, body: { error: { code: 'ASSET_INVALID' } } });
    expect(await request(origin, 'DELETE', '/v1/projects/p/assets/asset-1')).toMatchObject({
      status: 200,
      body: { data: { id: 'asset-1' } },
    });
    expect(await request(origin, 'GET', '/v1/projects/p/assets')).toMatchObject({
      status: 200,
      body: { data: [] },
    });
    expect(await request(origin, 'DELETE', '/v1/projects/p/assets/asset-1')).toMatchObject({
      status: 409,
      body: { error: { code: 'ASSET_NOT_FOUND' } },
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
    expect(
      await request(
        origin,
        'POST',
        '/v1/workers/w/leases',
        { durationMs: 5 * 60_000 + 1 },
        workerToken,
      ),
    ).toMatchObject({ status: 400, body: { error: { code: 'REQUEST_INVALID' } } });
    const lease = await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken);
    expect(lease).toMatchObject({
      status: 200,
      body: { data: { id: 'j', state: 'leased', leaseOwner: 'w' } },
    });
    const leaseToken = (lease.body as { data: { leaseToken: string } }).data.leaseToken;
    expect(
      await request(
        origin,
        'POST',
        '/v1/workers/w/jobs/j/heartbeat',
        { progress: 50, leaseToken },
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
        { progress: 60, leaseToken },
        workerToken,
      ),
    ).toMatchObject({ status: 200, body: { data: { cancelRequested: true } } });
    expect(
      await request(
        origin,
        'POST',
        '/v1/workers/w/jobs/j/fail',
        { error: 'canceled', leaseToken },
        workerToken,
      ),
    ).toMatchObject({ status: 200, body: { data: { state: 'canceled' } } });
    expect(await request(origin, 'POST', '/v1/projects/p/jobs/j/retry', {})).toMatchObject({
      status: 200,
      body: { data: { state: 'queued', progress: 0 } },
    });
    const retriedLease = await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken);
    const retriedLeaseToken = (retriedLease.body as { data: { leaseToken: string } }).data
      .leaseToken;
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
        leaseToken: retriedLeaseToken,
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
    const jobs = await request(origin, 'GET', '/v1/projects/p/jobs');
    expect(jobs).toMatchObject({
      status: 200,
      body: { data: [{ id: 'j', state: 'completed' }] },
    });
    expect(JSON.stringify(jobs.body)).not.toMatch(/localRef|locations|opfs-/i);
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

  it('forwards bounded Worker attempts and allows an explicit retry generation after exhaustion', async () => {
    const controlPlane = new LocalControlPlane();
    const owner = { id: 'attempt-owner' };
    controlPlane.createProject(owner, 'attempt-project', 'Attempts');
    controlPlane.registerAsset(owner, 'attempt-project', {
      id: 'attempt-asset',
      kind: 'image',
      displayName: 'attempt.png',
      sha256: SHA256,
      bytes: 12,
      descriptor: { mimeType: 'image/png', width: 64, height: 64 },
      locations: [{ kind: 'opfs-cache', ref: 'attempt-asset-cache' }],
    });
    controlPlane.pairWorker(owner, 'attempt-worker');
    controlPlane.helloWorker('attempt-worker', ['asset.thumbnail'], ['attempt-asset']);
    const origin = await start({ authenticate: () => owner }, undefined, undefined, controlPlane);

    expect(
      await request(origin, 'POST', '/v1/projects/attempt-project/jobs', {
        id: 'bounded-job',
        type: 'asset.thumbnail',
        assetId: 'attempt-asset',
        maxAttempts: 1,
      }),
    ).toMatchObject({ status: 201, body: { data: { id: 'bounded-job', state: 'queued' } } });
    expect(controlPlane.jobsForProject(owner, 'attempt-project')).toMatchObject([
      { id: 'bounded-job', maxAttempts: 1 },
    ]);
    expect(controlPlane.lease('attempt-worker', 100, 1)).toMatchObject({ id: 'bounded-job' });
    expect(controlPlane.lease('attempt-worker', 102, 1)).toBeUndefined();
    expect(
      await request(origin, 'POST', '/v1/projects/attempt-project/jobs/bounded-job/retry', {}),
    ).toMatchObject({ status: 200, body: { data: { state: 'queued', generation: 1 } } });

    expect(
      await request(origin, 'POST', '/v1/projects/attempt-project/jobs', {
        id: 'unbounded-job',
        type: 'asset.thumbnail',
        assetId: 'attempt-asset',
      }),
    ).toMatchObject({ status: 201, body: { data: { id: 'unbounded-job', state: 'queued' } } });
    expect(controlPlane.lease('attempt-worker', 104, 1)).toMatchObject({
      id: 'bounded-job',
      generation: 1,
    });
    expect(controlPlane.lease('attempt-worker', 106, 1)).toMatchObject({ id: 'unbounded-job' });
    expect(controlPlane.lease('attempt-worker', 108, 1)).toMatchObject({ id: 'unbounded-job' });

    expect(
      await request(origin, 'POST', '/v1/projects/attempt-project/jobs', {
        id: 'oversized-job',
        type: 'asset.thumbnail',
        assetId: 'attempt-asset',
        maxAttempts: MAX_WORKER_ATTEMPTS + 1,
      }),
    ).toMatchObject({ status: 400, body: { error: { code: 'REQUEST_INVALID' } } });
  });

  it('keeps mask prompts private to the authenticated Worker lease', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    await request(origin, 'POST', '/v1/projects', { id: 'mask-project', title: 'Mask' });
    await request(origin, 'POST', '/v1/projects/mask-project/assets', {
      id: 'mask-source',
      kind: 'image',
      displayName: 'subject.png',
      sha256: SHA256,
      bytes: 12,
      descriptor: { mimeType: 'image/png', width: 640, height: 360 },
      locations: [{ kind: 'opfs-cache', ref: 'mask-source-cache' }],
    });
    await request(origin, 'POST', '/v1/worker-pair/offers', {
      workerId: 'mask-worker',
      pairingCode: 'mask-pairing-code',
    });
    await request(origin, 'POST', '/v1/workers/mask-worker/pair', {
      pairingCode: 'mask-pairing-code',
    });
    const claim = await request(origin, 'POST', '/v1/worker-pair/claim', {
      workerId: 'mask-worker',
      pairingCode: 'mask-pairing-code',
    });
    const workerToken = (claim.body as { data: { sessionToken: string } }).data.sessionToken;
    await request(
      origin,
      'POST',
      '/v1/workers/mask-worker/hello',
      { capabilities: ['mask.image'], assetIds: ['mask-source'] },
      workerToken,
    );
    const payload = {
      schemaVersion: 1,
      provider: 'sam2-grounded',
      selection: { mode: 'prompt', prompt: 'red bicycle' },
      edge: { featherPx: 2, expansionPx: 0, detail: 0.8, decontaminate: true },
      invert: false,
      output: 'matte',
    };
    const queued = await request(origin, 'POST', '/v1/projects/mask-project/jobs', {
      id: 'mask-job',
      type: 'mask.image',
      assetId: 'mask-source',
      payload,
    });
    expect(queued).toMatchObject({ status: 201, body: { data: { id: 'mask-job' } } });
    expect(JSON.stringify(queued.body)).not.toContain('red bicycle');
    const jobs = await request(origin, 'GET', '/v1/projects/mask-project/jobs');
    expect(JSON.stringify(jobs.body)).not.toContain('red bicycle');
    expect(
      await request(origin, 'POST', '/v1/workers/mask-worker/leases', {}, workerToken),
    ).toMatchObject({
      status: 200,
      body: { data: { id: 'mask-job', payload } },
    });
  });

  it('rejects browser-supplied private-object claims for asset and local derivative registration', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' });

    const assetRegistrationAttempt = await request(origin, 'POST', '/v1/projects/p/assets', {
      id: 'asset-private-claim',
      kind: 'video',
      displayName: 'clip.mp4',
      sha256: SHA256,
      bytes: 12,
      descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000 },
      locations: [{ kind: 'private-object', ref: 'orig-shared-content' }],
    });
    expect(assetRegistrationAttempt).toMatchObject({
      status: 400,
      body: {
        error: {
          code: 'REQUEST_INVALID',
          message: 'asset registration must provide exactly one local cache location',
        },
      },
    });

    await request(origin, 'POST', '/v1/projects/p/assets', {
      id: 'asset-local',
      kind: 'video',
      displayName: 'clip.mp4',
      sha256: SHA256,
      bytes: 12,
      descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000 },
      locations: [{ kind: 'opfs-cache', ref: 'opfs-video' }],
    });

    const derivativeRegistrationAttempt = await request(
      origin,
      'POST',
      '/v1/projects/p/assets/asset-local/derivatives',
      {
        id: 'derivative-private-claim',
        assetId: 'asset-local',
        kind: 'proxy',
        profile: 'h264-720p',
        sha256: 'b'.repeat(64),
        bytes: 1234,
        descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000, width: 1280, height: 720 },
        availability: 'available-local',
        locations: [
          { kind: 'opfs-cache', ref: 'opfs-derivative' },
          { kind: 'private-object', ref: 'derivative-shared-content' },
        ],
      },
    );
    expect(derivativeRegistrationAttempt).toMatchObject({
      status: 400,
      body: {
        error: {
          code: 'REQUEST_INVALID',
          message: 'derivative registration must provide exactly one local cache location',
        },
      },
    });
  });
});

describe('PUT /v1/projects/:projectId/document - project document sync route', () => {
  it('returns 401 when unauthenticated', async () => {
    const origin = await start({ authenticate: () => undefined });
    const result = await request(
      origin,
      'PUT',
      '/v1/projects/test-project/document',
      validProjectDocumentSyncEnvelope('test-project'),
    );
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('first CAS write succeeds with 200 and returns projectId and revisionId', async () => {
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner-1' }, 'project-1', 'Test Project');
    const origin = await start(
      { authenticate: () => ({ id: 'owner-1' }) },
      undefined,
      undefined,
      controlPlane,
    );
    const envelope = validProjectDocumentSyncEnvelope('project-1', INITIAL_REVISION, 'rev-1');
    const result = await request(origin, 'PUT', '/v1/projects/project-1/document', envelope);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ data: { projectId: 'project-1', revisionId: 'rev-1' } });
  });

  it('update CAS write succeeds when baseRevisionId matches current', async () => {
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner-1' }, 'project-1', 'Test Project');
    const validDoc = validProjectDocumentSyncEnvelope('project-1').document;
    await controlPlane.writeProjectDocument(
      { id: 'owner-1' },
      { projectId: 'project-1', ownerId: 'owner-1', revisionId: 'rev-1', document: validDoc },
      INITIAL_REVISION,
    );
    const origin = await start(
      { authenticate: () => ({ id: 'owner-1' }) },
      undefined,
      undefined,
      controlPlane,
    );
    const envelope = validProjectDocumentSyncEnvelope('project-1', 'rev-1', 'rev-2');
    const result = await request(origin, 'PUT', '/v1/projects/project-1/document', envelope);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ data: { projectId: 'project-1', revisionId: 'rev-2' } });
  });

  it('returns 409 DOCUMENT_REVISION_CONFLICT when baseRevisionId does not match current', async () => {
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner-1' }, 'project-1', 'Test Project');
    const validDoc = validProjectDocumentSyncEnvelope('project-1').document;
    await controlPlane.writeProjectDocument(
      { id: 'owner-1' },
      { projectId: 'project-1', ownerId: 'owner-1', revisionId: 'rev-1', document: validDoc },
      INITIAL_REVISION,
    );
    const origin = await start(
      { authenticate: () => ({ id: 'owner-1' }) },
      undefined,
      undefined,
      controlPlane,
    );
    const envelope = validProjectDocumentSyncEnvelope('project-1', 'wrong-base-rev', 'rev-2');
    const result = await request(origin, 'PUT', '/v1/projects/project-1/document', envelope);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: 'DOCUMENT_REVISION_CONFLICT' } });
  });

  it('returns 404 PROJECT_NOT_FOUND for unknown project', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner-1' }) });
    const envelope = validProjectDocumentSyncEnvelope('unknown-project');
    const result = await request(origin, 'PUT', '/v1/projects/unknown-project/document', envelope);
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: 'PROJECT_NOT_FOUND' } });
  });

  it('returns 404 PROJECT_NOT_FOUND for owner-denied access', async () => {
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner-1' }, 'project-1', 'Test Project');
    const origin = await start(
      { authenticate: () => ({ id: 'owner-2' }) },
      undefined,
      undefined,
      controlPlane,
    );
    const envelope = validProjectDocumentSyncEnvelope('project-1');
    const result = await request(origin, 'PUT', '/v1/projects/project-1/document', envelope);
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: 'PROJECT_NOT_FOUND' } });
  });

  it('returns 400 REQUEST_INVALID for envelope rejection - forbidden fields', async () => {
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner-1' }, 'project-1', 'Test Project');
    const origin = await start(
      { authenticate: () => ({ id: 'owner-1' }) },
      undefined,
      undefined,
      controlPlane,
    );
    const envelope = {
      ...validProjectDocumentSyncEnvelope('project-1'),
      projectId: 'project-1', // forbidden field
    };
    const result = await request(origin, 'PUT', '/v1/projects/project-1/document', envelope);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'REQUEST_INVALID' } });
  });

  it('returns 400 REQUEST_INVALID for envelope rejection - ownerId in body', async () => {
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner-1' }, 'project-1', 'Test Project');
    const origin = await start(
      { authenticate: () => ({ id: 'owner-1' }) },
      undefined,
      undefined,
      controlPlane,
    );
    const envelope = {
      ...validProjectDocumentSyncEnvelope('project-1'),
      ownerId: 'owner-1', // forbidden field
    };
    const result = await request(origin, 'PUT', '/v1/projects/project-1/document', envelope);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'REQUEST_INVALID' } });
  });

  it('returns 400 REQUEST_INVALID for validation failure - missing fields', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner-1' }) });
    const envelope = { baseRevisionId: '' }; // missing revisionId and document
    const result = await request(origin, 'PUT', '/v1/projects/project-1/document', envelope);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'REQUEST_INVALID' } });
  });

  it('returns 400 REQUEST_INVALID for validation failure - empty revisionId', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner-1' }) });
    const envelope = {
      baseRevisionId: '',
      revisionId: '', // empty revisionId
      document: {
        schemaVersion: 1,
        id: 'project-1',
        title: 'Test',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        rootCompositionId: 'comp-1',
        settings: { defaultLocale: 'en' },
        compositions: {
          'comp-1': {
            id: 'comp-1',
            name: 'Root',
            width: 1920,
            height: 1080,
            pixelAspectRatio: { num: 1, den: 1 },
            frameRate: { num: 30, den: 1 },
            durationUs: 10000000,
            background: '#00000000',
            tracks: [],
          },
        },
        assets: {},
        variables: {},
        markers: [],
        visualObjects: {},
        captionDocuments: {},
        pluginData: {},
      },
    };
    const result = await request(origin, 'PUT', '/v1/projects/project-1/document', envelope);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'REQUEST_INVALID' } });
  });

  it('accepts document with distinct canonical editor document ID under authorized control-plane project', async () => {
    // document.id is the canonical editor-document ID and can differ from URL path projectId
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner-1' }, 'project-1', 'Test Project');
    const origin = await start(
      { authenticate: () => ({ id: 'owner-1' }) },
      undefined,
      undefined,
      controlPlane,
    );
    const envelope = {
      baseRevisionId: '',
      revisionId: 'rev-1',
      document: {
        schemaVersion: 1,
        id: 'editor-doc-123', // different from URL path project-1
        title: 'Test',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        rootCompositionId: 'comp-1',
        settings: { defaultLocale: 'en' },
        compositions: {
          'comp-1': {
            id: 'comp-1',
            name: 'Root',
            width: 1920,
            height: 1080,
            pixelAspectRatio: { num: 1, den: 1 },
            frameRate: { num: 30, den: 1 },
            durationUs: 10000000,
            background: '#00000000',
            tracks: [],
          },
        },
        assets: {},
        variables: {},
        markers: [],
        visualObjects: {},
        captionDocuments: {},
        pluginData: {},
      },
    };
    const result = await request(origin, 'PUT', '/v1/projects/project-1/document', envelope);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ data: { projectId: 'project-1', revisionId: 'rev-1' } });
  });

  it('returns 400 REQUEST_INVALID for oversized payload', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner-1' }) });
    const largeTitle = 'A'.repeat(MAX_PROJECT_DOCUMENT_SYNC_BYTES);
    const largeDocument: JoyProjectV1 = {
      schemaVersion: 1,
      id: 'project-1',
      title: largeTitle,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      rootCompositionId: 'comp-1',
      settings: { defaultLocale: 'en' },
      compositions: {
        'comp-1': {
          id: 'comp-1',
          name: 'Root',
          width: 1920,
          height: 1080,
          pixelAspectRatio: { num: 1, den: 1 },
          frameRate: { num: 30, den: 1 },
          durationUs: 10000000,
          background: '#00000000',
          tracks: [],
        },
      },
      assets: {},
      variables: {},
      markers: [],
      visualObjects: {},
      captionDocuments: {},
      pluginData: {},
    };
    const envelope = {
      baseRevisionId: '',
      revisionId: 'rev-1',
      document: largeDocument,
    };
    const result = await request(origin, 'PUT', '/v1/projects/project-1/document', envelope);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'REQUEST_INVALID' } });
  });

  it('bounds ordinary JSON routes before parsing oversized bodies', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner-1' }) });
    const result = await request(origin, 'POST', '/v1/projects', {
      id: 'project-1',
      title: 'A'.repeat(DEFAULT_MAX_JSON_BODY_BYTES),
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: { code: 'REQUEST_INVALID', message: 'request body exceeds the size limit' },
    });
  });

  it('derives ownerId only from authenticated actor - ignores body ownerId', async () => {
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner-1' }, 'project-1', 'Test Project');
    const origin = await start(
      { authenticate: () => ({ id: 'owner-1' }) },
      undefined,
      undefined,
      controlPlane,
    );
    const envelope = {
      ...validProjectDocumentSyncEnvelope('project-1'),
      ownerId: 'malicious-owner', // should be ignored
    };
    const result = await request(origin, 'PUT', '/v1/projects/project-1/document', envelope);
    expect(result.status).toBe(400); // validation should reject this
    expect(result.body).toMatchObject({ error: { code: 'REQUEST_INVALID' } });
  });

  it('derives projectId only from URL path - ignores body projectId', async () => {
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner-1' }, 'project-1', 'Test Project');
    const origin = await start(
      { authenticate: () => ({ id: 'owner-1' }) },
      undefined,
      undefined,
      controlPlane,
    );
    const envelope = {
      ...validProjectDocumentSyncEnvelope('project-1'),
      projectId: 'malicious-project', // should be ignored
    };
    const result = await request(origin, 'PUT', '/v1/projects/project-1/document', envelope);
    expect(result.status).toBe(400); // validation should reject this
    expect(result.body).toMatchObject({ error: { code: 'REQUEST_INVALID' } });
  });
});

describe('GET /v1/projects/:projectId/document - project document hydration route', () => {
  it('returns 401 when unauthenticated', async () => {
    const origin = await start({ authenticate: () => undefined });
    const result = await request(origin, 'GET', '/v1/projects/project-1/document');
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('returns the latest owner-authorized document and revision', async () => {
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner-1' }, 'project-1', 'Test Project');
    const envelope = validProjectDocumentSyncEnvelope('editor-doc-1', INITIAL_REVISION, 'rev-1');
    await controlPlane.writeProjectDocument(
      { id: 'owner-1' },
      {
        projectId: 'project-1',
        ownerId: 'owner-1',
        revisionId: envelope.revisionId,
        document: envelope.document,
      },
      INITIAL_REVISION,
    );
    const origin = await start(
      { authenticate: () => ({ id: 'owner-1' }) },
      undefined,
      undefined,
      controlPlane,
    );
    const result = await request(origin, 'GET', '/v1/projects/project-1/document');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      data: {
        projectId: 'project-1',
        revisionId: 'rev-1',
        document: { id: 'editor-doc-1', title: 'Test Project' },
      },
    });
  });

  it('does not disclose a document to another owner', async () => {
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner-1' }, 'project-1', 'Test Project');
    const envelope = validProjectDocumentSyncEnvelope('editor-doc-1');
    await controlPlane.writeProjectDocument(
      { id: 'owner-1' },
      {
        projectId: 'project-1',
        ownerId: 'owner-1',
        revisionId: envelope.revisionId,
        document: envelope.document,
      },
      INITIAL_REVISION,
    );
    const origin = await start(
      { authenticate: () => ({ id: 'owner-2' }) },
      undefined,
      undefined,
      controlPlane,
    );
    const result = await request(origin, 'GET', '/v1/projects/project-1/document');
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: 'PROJECT_DOCUMENT_NOT_FOUND' } });
  });

  it('returns the current revision when a requested revision is stale', async () => {
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner-1' }, 'project-1', 'Test Project');
    const envelope = validProjectDocumentSyncEnvelope('editor-doc-1');
    await controlPlane.writeProjectDocument(
      { id: 'owner-1' },
      {
        projectId: 'project-1',
        ownerId: 'owner-1',
        revisionId: envelope.revisionId,
        document: envelope.document,
      },
      INITIAL_REVISION,
    );
    const origin = await start(
      { authenticate: () => ({ id: 'owner-1' }) },
      undefined,
      undefined,
      controlPlane,
    );
    const result = await request(
      origin,
      'GET',
      '/v1/projects/project-1/document?revisionId=old-revision',
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      error: { code: 'DOCUMENT_REVISION_STALE', currentRevisionId: 'rev-1' },
    });
  });
});
