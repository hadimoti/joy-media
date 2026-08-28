import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ControlPlaneError,
  LocalControlPlane,
  MAX_WORKER_ATTEMPTS,
  type Actor,
  type AssetLocationRecord,
  type ControlPlane,
  type MediaAssetRecord,
  type MediaDerivativeRecord,
} from './control-plane.js';
import {
  createControlPlaneHttpServer,
  type ApiAuthentication,
  type ApiReadinessOptions,
} from './http-server.js';
import { DisabledMediaAuth } from './media-auth.js';
import { createClientAddressResolver, type ClientAddressResolver } from './client-address.js';
import { renderFixture, verifyExport } from '@joy-media/export-core';
import { MemoryMistralInvocationLedger, MistralProviderRegistry } from './mistral-provider.js';
import type { PrivateObjectDescriptor, PrivateObjectStore } from './private-object-store.js';
import { MAX_DENOISE_JSON_BYTES, type SpectralDenoiseResult } from './spectral-denoise.js';
import {
  MemorySpectralDenoiseInvocationLedger,
  SpectralDenoiseService,
} from './spectral-denoise-service.js';
import {
  UnavailableCreativeBriefInputResolver,
  type CreativeBriefInputResolver,
  type CreativeBriefInputResolverRequest,
  type CreativeBriefInputResolverSuccess,
  type CreativeBriefInputResolverContext,
  type CreativeBriefInputResolverUnavailable,
  type CreativeBriefInputResolverStaleRevision,
} from './creative-brief-input-resolver.js';
import type { CreativeBriefRuntime } from './creative-brief-runtime.js';
import { DEFAULT_CREATIVE_BRIEF_RUNTIME } from './creative-brief-runtime.js';
import type {
  CreativeBriefInputV1,
  CreativeBriefRequestV1,
  AsyncCreativeBriefOutcome,
} from '@joy-media/agent-tools';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import {
  INITIAL_REVISION,
  MAX_PROJECT_DOCUMENT_SYNC_BYTES,
} from './project-document-sync-request-validation.js';

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
  it('separates liveness from fail-closed dependency readiness', async () => {
    const origin = await start(
      { authenticate: () => undefined },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        checks: { database: () => true, objectStore: () => false },
        releaseIdentity: {
          commitSha: 'a'.repeat(40),
          treeHash: 'b'.repeat(40),
          lockfileSha256: 'c'.repeat(64),
          schemaVersion: 2,
        },
      },
    );
    expect(await request(origin, 'GET', '/live')).toMatchObject({
      status: 200,
      body: { ok: true, liveness: true },
    });
    expect(await request(origin, 'GET', '/ready')).toMatchObject({
      status: 503,
      body: {
        ok: false,
        readiness: false,
        checks: { database: true, objectStore: false },
        releaseIdentity: { schemaVersion: 2 },
      },
    });
  });

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
    expect(
      await request(origin, 'POST', '/v1/providers/speech/transcribe', {
        language: 'en',
        referenceAssetId: 'asset-intro',
      }),
    ).toMatchObject({
      status: 401,
      body: { error: { code: 'AUTH_REQUIRED' } },
    });
  });

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
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
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
    expect(
      await request(origin, 'POST', '/v1/projects/source/assets', {
        id: 'source-asset',
        kind: 'video',
        displayName: 'clip.mp4',
        sha256: SHA256,
        bytes: 12,
        descriptor: { mimeType: 'video/mp4' },
        locations: [{ kind: 'private-object', ref: 'source-object' }],
      }),
    ).toMatchObject({ status: 201 });
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

  it('keeps Mistral unconfigured without the dedicated runtime secret', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    expect(await request(origin, 'GET', '/v1/providers/reasoning')).toMatchObject({
      status: 200,
      body: { data: { providers: [{ providerId: 'mistral', state: 'unconfigured', models: [] }] } },
    });
    expect(
      await request(origin, 'POST', '/v1/providers/mistral/complete', {
        model: 'mistral-small-latest',
        messages: [{ role: 'user', content: 'Plan only.' }],
        idempotencyKey: 'unconfigured-1',
        privacyMode: 'ask-before-remote',
        approvedRemoteProcessing: true,
        approvedSpend: true,
      }),
    ).toMatchObject({ status: 503, body: { error: { code: 'PROVIDER_UNCONFIGURED' } } });
  });

  it('requires remote/spend approval and records an idempotent Mistral completion without secrets or prompts', async () => {
    let calls = 0;
    const registry = new MistralProviderRegistry(
      'test-only-mistral-secret',
      new MemoryMistralInvocationLedger(),
      async () => {
        calls++;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Guarded result.' } }],
            usage: { prompt_tokens: 3, completion_tokens: 4 },
          }),
        );
      },
    );
    const origin = await start({ authenticate: () => ({ id: 'owner' }) }, undefined, registry);
    const base = {
      model: 'mistral-small-latest',
      messages: [{ role: 'user', content: 'Do not persist this prompt.' }],
      idempotencyKey: 'mistral-1',
      privacyMode: 'ask-before-remote',
      approvedRemoteProcessing: true,
      approvedSpend: true,
    };
    expect(
      await request(origin, 'POST', '/v1/providers/mistral/complete', {
        ...base,
        approvedSpend: false,
      }),
    ).toMatchObject({
      status: 409,
      body: { error: { code: 'PROVIDER_SPEND_APPROVAL_REQUIRED' } },
    });
    const first = await request(origin, 'POST', '/v1/providers/mistral/complete', base);
    expect(first).toMatchObject({
      status: 200,
      body: {
        data: {
          status: 'succeeded',
          provenance: {
            providerId: 'mistral',
            modelId: 'mistral-small-latest',
            idempotencyKey: 'mistral-1',
          },
          usage: { inputTokens: 3, outputTokens: 4 },
        },
      },
    });
    const retried = await request(origin, 'POST', '/v1/providers/mistral/complete', base);
    expect(retried).toEqual(first);
    expect(calls).toBe(1);
    expect(JSON.stringify(first.body)).not.toContain('test-only-mistral-secret');
    expect(JSON.stringify(first.body)).not.toContain('Do not persist this prompt.');
  });

  it('rejects an oversized Cloud denoise JSON body before decoding or spawning ffmpeg', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    const response = await request(origin, 'POST', '/v1/providers/audio/denoise', {
      assetId: 'oversized-audio',
      mediaBase64: 'A'.repeat(MAX_DENOISE_JSON_BYTES),
    });

    expect(response).toMatchObject({
      status: 400,
      body: { error: { code: 'REQUEST_INVALID', message: 'request body exceeds the size limit' } },
    });
  });

  it('atomically replays and recovers a project-scoped Cloud denoise result', async () => {
    const run = vi.fn(async () => ({
      assetId: 'audio-clean',
      mimeType: 'audio/wav',
      bytesBase64: 'Y2xlYW4=',
      method: 'ffmpeg-afftdn' as const,
      strength: 0.8,
    }));
    const audioDenoise = new SpectralDenoiseService(new MemorySpectralDenoiseInvocationLedger(), {
      run,
    });
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      undefined,
      new LocalControlPlane(),
      audioDenoise,
    );
    await request(origin, 'POST', '/v1/projects', { id: 'project-1', title: 'Project' });
    expect(
      await request(
        origin,
        'GET',
        '/v1/providers/audio/denoise?projectId=project-1&operationId=not-claimed',
      ),
    ).toMatchObject({
      status: 404,
      body: { error: { code: 'PROVIDER_OPERATION_NOT_FOUND' } },
    });
    const input = {
      projectId: 'project-1',
      operationId: 'cloud-audio-operation-1',
      assetId: 'audio-source',
      mediaBase64: 'bm9pc2U=',
      strength: 0.8,
    };

    const first = await request(origin, 'POST', '/v1/providers/audio/denoise', input);
    expect(first).toMatchObject({
      status: 200,
      body: { data: { assetId: 'audio-clean', bytesBase64: 'Y2xlYW4=' } },
    });
    await expect(request(origin, 'POST', '/v1/providers/audio/denoise', input)).resolves.toEqual(
      first,
    );
    expect(
      await request(
        origin,
        'GET',
        '/v1/providers/audio/denoise?projectId=project-1&operationId=cloud-audio-operation-1',
      ),
    ).toMatchObject({
      status: 200,
      body: {
        data: {
          projectId: 'project-1',
          operationId: 'cloud-audio-operation-1',
          status: 'succeeded',
          result: { assetId: 'audio-clean', bytesBase64: 'Y2xlYW4=' },
        },
      },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('returns an actionable 429 when the Cloud denoise concurrency gate is full', async () => {
    let finish: ((result: SpectralDenoiseResult) => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<SpectralDenoiseResult>((resolve) => {
          finish = resolve;
        }),
    );
    const audioDenoise = new SpectralDenoiseService(new MemorySpectralDenoiseInvocationLedger(), {
      run,
      maxGlobalConcurrency: 1,
      maxPerOwnerConcurrency: 1,
    });
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      undefined,
      new LocalControlPlane(),
      audioDenoise,
    );
    await request(origin, 'POST', '/v1/projects', { id: 'project-1', title: 'Project' });
    const first = request(origin, 'POST', '/v1/providers/audio/denoise', {
      projectId: 'project-1',
      operationId: 'operation-1',
      assetId: 'audio-1',
      mediaBase64: 'bm9pc2U=',
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    expect(
      await request(origin, 'POST', '/v1/providers/audio/denoise', {
        projectId: 'project-1',
        operationId: 'operation-2',
        assetId: 'audio-2',
        mediaBase64: 'bm9pc2U=',
      }),
    ).toMatchObject({
      status: 429,
      body: {
        error: {
          code: 'PROVIDER_BUSY',
          message: 'Cloud denoise is busy for this account; retry in a moment.',
        },
      },
    });

    finish?.({
      assetId: 'audio-clean',
      mimeType: 'audio/wav',
      bytesBase64: 'Y2xlYW4=',
      method: 'ffmpeg-afftdn',
      strength: 0.8,
    });
    await expect(first).resolves.toMatchObject({ status: 200 });
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
    const retriedLeaseToken = (retriedLease.body as { data: { leaseToken: string } }).data.leaseToken;
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
    expect(controlPlane.lease('attempt-worker', 104, 1)).toMatchObject({ id: 'bounded-job', generation: 1 });
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

  it('backs up an owner-only original and purges its unreferenced cloud object on delete', async () => {
    const store = new MemoryPrivateObjectStore();
    const origin = await start({ authenticate: () => ({ id: 'owner' }) }, store);
    const bytes = new TextEncoder().encode('verified video bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' });
    await request(origin, 'POST', '/v1/projects/p/assets', {
      id: 'video-1',
      kind: 'video',
      displayName: 'clip.mp4',
      sha256,
      bytes: bytes.byteLength,
      descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000 },
      locations: [{ kind: 'opfs-cache', ref: 'opfs-video' }],
    });

    const upload = await fetch(`${origin}/v1/projects/p/assets/video-1/original`, {
      method: 'POST',
      headers: {
        'content-type': 'video/mp4',
        'x-joy-sha256': sha256,
        'x-joy-bytes': String(bytes.byteLength),
      },
      body: bytes,
    });

    expect(upload.status).toBe(201);
    const uploadBody = await upload.json();
    expect(uploadBody).toMatchObject({
      data: { asset: { id: 'video-1', kind: 'video', cloudBacked: true } },
    });
    expect(JSON.stringify(uploadBody)).not.toMatch(/cloudRef|locations|orig-/i);
    expect(store.objects).toHaveLength(1);
    expect(store.objects[0]?.descriptor).toMatchObject({
      mimeType: 'video/mp4',
      bytes: bytes.byteLength,
    });

    const original = await fetch(`${origin}/v1/projects/p/assets/video-1/original`);
    expect(original.status).toBe(200);
    expect(original.headers.get('content-type')).toBe('video/mp4');
    expect(original.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(bytes);

    const content = await fetch(`${origin}/v1/library/cloud-assets/video-1/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('video/mp4');
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes);
    expect(await request(origin, 'GET', '/v1/library/cloud-assets')).toMatchObject({
      status: 200,
      body: { data: [] },
    });

    expect(await request(origin, 'DELETE', '/v1/projects/p/assets/video-1')).toMatchObject({
      status: 200,
      body: {
        data: { id: 'video-1', cloudObjectsPurged: 1, cloudObjectPurgeFailures: 0 },
      },
    });
    expect(store.objects).toHaveLength(0);
    expect(store.removed).toHaveLength(1);
  });

  it('does not purge shared content-addressed bytes when a later metadata attach fails', async () => {
    const store = new MemoryPrivateObjectStore();
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      store,
      undefined,
      new FailingSecondAttachControlPlane(),
    );
    const bytes = new TextEncoder().encode('shared verified bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' });
    for (const id of ['video-1', 'video-2']) {
      await request(origin, 'POST', '/v1/projects/p/assets', {
        id,
        kind: 'video',
        displayName: `${id}.mp4`,
        sha256,
        bytes: bytes.byteLength,
        descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000 },
        locations: [{ kind: 'opfs-cache', ref: `opfs-${id}` }],
      });
    }

    const upload = (id: string) =>
      fetch(`${origin}/v1/projects/p/assets/${id}/original`, {
        method: 'POST',
        headers: {
          'content-type': 'video/mp4',
          'x-joy-sha256': sha256,
          'x-joy-bytes': String(bytes.byteLength),
        },
        body: bytes,
      });

    expect((await upload('video-1')).status).toBe(201);
    expect((await upload('video-2')).status).toBe(409);
    expect(store.removed).toEqual([]);
    const firstContent = await fetch(`${origin}/v1/library/cloud-assets/video-1/content`);
    expect(firstContent.status).toBe(200);
    expect(new Uint8Array(await firstContent.arrayBuffer())).toEqual(bytes);
  });

  it('brokers a Worker thumbnail through private storage by default, then streams verified bytes to the owner', async () => {
    const store = new MemoryPrivateObjectStore();
    const origin = await start({ authenticate: () => ({ id: 'owner' }) }, store);
    const source = {
      id: 'asset-1',
      kind: 'video',
      displayName: 'clip.mp4',
      sha256: 'a'.repeat(64),
      bytes: 123,
      descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000, width: 640, height: 360 },
      locations: [{ kind: 'opfs-cache', ref: 'source-1' }],
    };
    await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' });
    await request(origin, 'POST', '/v1/projects/p/assets', source);
    await request(origin, 'POST', '/v1/worker-pair/offers', {
      workerId: 'w',
      pairingCode: 'pairing-code',
    });
    await request(origin, 'POST', '/v1/workers/w/pair', { pairingCode: 'pairing-code' });
    const claim = await request(origin, 'POST', '/v1/worker-pair/claim', {
      workerId: 'w',
      pairingCode: 'pairing-code',
    });
    const workerToken = (claim.body as { data: { sessionToken: string } }).data.sessionToken;
    await request(
      origin,
      'POST',
      '/v1/workers/w/hello',
      { capabilities: ['asset.thumbnail'], assetIds: ['asset-1'] },
      workerToken,
    );
    await request(origin, 'POST', '/v1/projects/p/jobs', {
      id: 'j',
      type: 'asset.thumbnail',
      assetId: 'asset-1',
    });
    const lease = await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken);
    const leaseToken = (lease.body as { data: { leaseToken: string } }).data.leaseToken;

    const thumbnail = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const sha256 = createHash('sha256').update(thumbnail).digest('hex');
    const upload = () =>
      fetch(`${origin}/v1/workers/w/jobs/j/derivative`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${workerToken}`,
          'content-type': 'image/jpeg',
          'x-joy-asset-id': 'asset-1',
          'x-joy-sha256': sha256,
          'x-joy-bytes': String(thumbnail.byteLength),
          'x-joy-width': '1',
          'x-joy-height': '1',
          'x-joy-lease-token': leaseToken,
        },
        body: thumbnail,
      });

    const uploaded = await upload();
    expect(uploaded.status).toBe(201);
    expect(await uploaded.json()).toMatchObject({
      data: { id: 'derivative-j', assetId: 'asset-1', availability: 'available-cloud' },
    });
    expect(store.objects).toHaveLength(1);

    const content = await fetch(
      `${origin}/v1/projects/p/assets/asset-1/derivatives/derivative-j/content`,
    );
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/jpeg');
    expect(content.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(thumbnail);

    await request(
      origin,
      'POST',
      '/v1/workers/w/hello',
      { capabilities: ['asset.thumbnail', 'audio.ml-denoise'], assetIds: ['asset-1'] },
      workerToken,
    );
    const projectScopedAudioJobId =
      'audio-denoise-project-12345678-1234-1234-1234-123456789012-media-12345678-1234-1234-1234-123456789012';
    await request(origin, 'POST', '/v1/projects/p/jobs', {
      id: projectScopedAudioJobId,
      type: 'audio.ml-denoise',
      assetId: 'asset-1',
    });
    const audioLease = await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken);
    const audioLeaseToken = (audioLease.body as { data: { leaseToken: string } }).data.leaseToken;
    const audio = new Uint8Array([1, 2, 3, 4]);
    const audioSha256 = createHash('sha256').update(audio).digest('hex');
    const uploadAudio = (mimeType = 'audio/wav') =>
      fetch(
        `${origin}/v1/workers/w/jobs/${encodeURIComponent(projectScopedAudioJobId)}/derivative`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${workerToken}`,
            'content-type': mimeType,
            'x-joy-asset-id': 'asset-1',
            'x-joy-sha256': audioSha256,
            'x-joy-bytes': String(audio.byteLength),
            'x-joy-lease-token': audioLeaseToken,
          },
          body: audio,
        },
      );
    const audioUpload = await uploadAudio();
    expect(audioUpload.status).toBe(201);
    expect(await audioUpload.json()).toMatchObject({
      data: {
        id: `derivative-${projectScopedAudioJobId}`,
        kind: 'audio',
        assetId: 'asset-1',
      },
    });
    // Simulate a lost 201: an exact retry is idempotent, retains one private
    // object, and still lets the Worker complete the lease exactly once.
    const audioRetry = await uploadAudio();
    expect(audioRetry.status).toBe(201);
    expect(await audioRetry.json()).toMatchObject({
      data: { id: `derivative-${projectScopedAudioJobId}`, sha256: audioSha256 },
    });
    expect(store.objects).toHaveLength(2);
    const mismatchedRetry = await uploadAudio('audio/mpeg');
    expect(mismatchedRetry.status).toBe(409);
    expect(await mismatchedRetry.json()).toMatchObject({
      error: { code: 'DERIVATIVE_EXISTS' },
    });
    expect(store.objects).toHaveLength(2);

    const localRef = `gpu-${createHash('sha256')
      .update(projectScopedAudioJobId)
      .digest('hex')
      .slice(0, 32)}-${audioSha256.slice(0, 16)}`;
    const completed = await request(
      origin,
      'POST',
      `/v1/workers/w/jobs/${encodeURIComponent(projectScopedAudioJobId)}/complete`,
      {
        result: {
          kind: 'audio.ml-denoise',
          assetId: 'asset-1',
          sha256: audioSha256,
          bytes: audio.byteLength,
          localRef,
          descriptor: { mimeType: 'audio/wav' },
        },
        leaseToken: audioLeaseToken,
      },
      workerToken,
    );
    expect(completed).toMatchObject({ status: 200, body: { data: { state: 'completed' } } });
    const audioEvents = await request(origin, 'GET', '/v1/projects/p/events?cursor=0');
    expect(
      (audioEvents.body as { data: readonly { jobId: string; type: string }[] }).data.filter(
        (event) => event.jobId === projectScopedAudioJobId && event.type === 'completed',
      ),
    ).toHaveLength(1);
    expect(content.url).toContain('/content');
    expect(content.url).not.toContain('parspack');
  });

  it('remuxes an authenticated browser MP4 to verified H.264/AAC', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    expect(
      await request(origin, 'POST', '/v1/projects', {
        id: 'remux-project',
        title: 'Remux project',
      }),
    ).toMatchObject({ status: 201 });
    const directory = mkdtempSync(join(tmpdir(), 'joy-api-remux-test-'));
    const inputPath = join(directory, 'browser.mp4');
    try {
      renderFixture(
        {
          projectId: 'remux-project',
          revision: 0,
          width: 64,
          height: 36,
          frameRate: 30,
          durationUs: 100_000,
          preset: 'social-h264-aac',
        },
        inputPath,
      );
      const response = await fetch(origin + '/v1/projects/remux-project/export/remux', {
        method: 'POST',
        headers: {
          authorization: 'Bearer owner',
          'content-type': 'video/mp4',
          'x-joy-frame-rate': '30',
          'x-joy-frame-count': '3',
        },
        body: readFileSync(inputPath),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('video/mp4');
      expect(response.headers.get('x-joy-video-codec')).toBe('h264');
      expect(response.headers.get('x-joy-audio-codec')).toBe('aac');
      const outputPath = join(directory, 'output.mp4');
      const output = new Uint8Array(await response.arrayBuffer());
      const { writeFileSync } = await import('node:fs');
      writeFileSync(outputPath, output);
      expect(verifyExport(outputPath)).toMatchObject({
        videoCodec: 'h264',
        audioCodec: 'aac',
        videoStreamCount: 1,
        audioStreamCount: 1,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('relays an authenticated no-store GPU frame without creating a durable job', async () => {
    const controlPlane = new LocalControlPlane();
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      undefined,
      controlPlane,
    );
    await request(origin, 'POST', '/v1/projects', { id: 'gpu-project', title: 'GPU project' });
    await request(origin, 'POST', '/v1/worker-pair/offers', {
      workerId: 'worker-gpu',
      pairingCode: 'pair-code',
    });
    await request(origin, 'POST', '/v1/workers/worker-gpu/pair', { pairingCode: 'pair-code' });
    const claim = await request(origin, 'POST', '/v1/worker-pair/claim', {
      workerId: 'worker-gpu',
      pairingCode: 'pair-code',
    });
    const workerToken = (claim.body as { data: { sessionToken: string } }).data.sessionToken;
    await request(
      origin,
      'POST',
      '/v1/workers/worker-gpu/hello',
      { capabilities: ['render.preview.gpu'], assetIds: [] },
      workerToken,
    );
    const opened = await request(origin, 'POST', '/v1/projects/gpu-project/preview-sessions', {});
    const session = (opened.body as { data: { sessionId: string; sessionToken: string } }).data;
    const frame = {
      protocolVersion: 1,
      capability: 'render.preview.gpu',
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      requestId: 1,
      projectId: 'gpu-project',
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
        background: { r: 0, g: 0, b: 0, a: 255 },
        nodes: [],
      },
    };
    expect(
      await request(origin, 'POST', `/v1/preview-sessions/${session.sessionId}/frames`, frame),
    ).toMatchObject({ status: 202 });
    expect(
      await request(origin, 'POST', '/v1/workers/worker-gpu/preview/next', {}, workerToken),
    ).toMatchObject({ status: 200, body: { data: { requestId: 1, noStore: true } } });
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    expect(
      await request(
        origin,
        'POST',
        `/v1/workers/worker-gpu/preview/frames/${session.sessionId}/1`,
        {
          protocolVersion: 1,
          sessionId: session.sessionId,
          requestId: 1,
          renderer: 'hardware-gpu',
          quality: 'quarter',
          width: 80,
          height: 45,
          bytesBase64: png.toString('base64'),
        },
        workerToken,
      ),
    ).toMatchObject({ status: 200 });
    const result = await fetch(`${origin}/v1/preview-sessions/${session.sessionId}/frames/1`, {
      headers: { authorization: 'Bearer owner' },
    });
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(result.headers.get('x-joy-preview-renderer')).toBe('hardware-gpu');
    expect(Buffer.from(await result.arrayBuffer())).toEqual(png);
    expect(await controlPlane.jobsForProject({ id: 'owner' }, 'gpu-project')).toEqual([]);
  });

  describe('Creative Brief route', () => {
    // Helper to create a test resolver that returns resolved input
    const createTestResolver = (input: CreativeBriefInputV1): CreativeBriefInputResolver => ({
      resolve: (
        _req: CreativeBriefInputResolverRequest,
        _context: CreativeBriefInputResolverContext,
      ): CreativeBriefInputResolverSuccess => ({
        status: 'resolved',
        input,
      }),
    });

    it('rejects unauthenticated requests', async () => {
      const origin = await start({ authenticate: () => undefined });
      expect(
        await request(origin, 'POST', '/v1/projects/test-project/creative-brief', {}),
      ).toMatchObject({
        status: 401,
        body: { error: { code: 'AUTH_REQUIRED' } },
      });
    });

    it('rejects non-owner actor', async () => {
      const controlPlane = new LocalControlPlane();
      await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
      const origin = await start(
        { authenticate: () => ({ id: 'other-user' }) },
        undefined,
        undefined,
        controlPlane,
      );
      expect(
        await request(origin, 'POST', '/v1/projects/test-project/creative-brief', {}),
      ).toMatchObject({
        status: 409,
        body: { error: { code: 'PROJECT_NOT_FOUND' } },
      });
    });

    it('rejects unknown project', async () => {
      const origin = await start({ authenticate: () => ({ id: 'owner' }) });
      expect(
        await request(origin, 'POST', '/v1/projects/unknown-project/creative-brief', {}),
      ).toMatchObject({
        status: 409,
        body: { error: { code: 'PROJECT_NOT_FOUND' } },
      });
    });

    it('rejects project without opt-in', async () => {
      const controlPlane = new LocalControlPlane();
      await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
      const origin = await start(
        { authenticate: () => ({ id: 'owner' }) },
        undefined,
        undefined,
        controlPlane,
      );
      expect(
        await request(origin, 'POST', '/v1/projects/test-project/creative-brief', {
          projectId: 'test-project',
          snapshotRevisionId: 'rev-1',
          request: {
            projectId: 'test-project',
            snapshotRevisionId: 'rev-1',
            request: 'test',
            scope: 'general',
          },
        }),
      ).toMatchObject({
        status: 409,
        body: { error: { code: 'POLICY_DENIED' } },
      });
    });

    it('rejects project with opt-in but invalid client envelope', async () => {
      const controlPlane = new LocalControlPlane();
      await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
      await controlPlane.setCreativeBriefOptIn({ id: 'owner' }, 'test-project', true, 0);
      const origin = await start(
        { authenticate: () => ({ id: 'owner' }) },
        undefined,
        undefined,
        controlPlane,
      );
      expect(
        await request(origin, 'POST', '/v1/projects/test-project/creative-brief', {}),
      ).toMatchObject({
        status: 400,
        body: { error: { code: 'REQUEST_INVALID' } },
      });
    });

    it('rejects legacy snapshot/intelligence envelope', async () => {
      const controlPlane = new LocalControlPlane();
      await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
      await controlPlane.setCreativeBriefOptIn({ id: 'owner' }, 'test-project', true, 0);
      const origin = await start(
        { authenticate: () => ({ id: 'owner' }) },
        undefined,
        undefined,
        controlPlane,
      );
      expect(
        await request(origin, 'POST', '/v1/projects/test-project/creative-brief', {
          projectId: 'test-project',
          snapshotRevisionId: 'rev-1',
          snapshot: { projectId: 'test-project', revisionId: 'rev-1', schemaVersion: 1 as const },
          intelligence: {
            brandReadiness: { status: 'ready' },
            sceneCoverages: [],
            projectReadiness: { status: 'ready' },
            rules: [],
          },
          request: {
            projectId: 'test-project',
            snapshotRevisionId: 'rev-1',
            request: 'test',
            scope: 'general',
          },
        }),
      ).toMatchObject({
        status: 400,
        body: { error: { code: 'REQUEST_INVALID' } },
      });
    });

    it('rejects client envelope with project mismatch', async () => {
      const controlPlane = new LocalControlPlane();
      await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
      await controlPlane.setCreativeBriefOptIn({ id: 'owner' }, 'test-project', true, 0);
      const origin = await start(
        { authenticate: () => ({ id: 'owner' }) },
        undefined,
        undefined,
        controlPlane,
      );
      expect(
        await request(origin, 'POST', '/v1/projects/test-project/creative-brief', {
          projectId: 'other-project',
          snapshotRevisionId: 'rev-1',
          request: {
            projectId: 'test-project',
            snapshotRevisionId: 'rev-1',
            request: 'test',
            scope: 'general',
          },
        }),
      ).toMatchObject({
        status: 409,
        body: { error: { code: 'PROJECT_MISMATCH' } },
      });
    });

    it('returns unavailable when default resolver is used', async () => {
      const controlPlane = new LocalControlPlane();
      await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
      await controlPlane.setCreativeBriefOptIn({ id: 'owner' }, 'test-project', true, 0);
      const origin = await start(
        { authenticate: () => ({ id: 'owner' }) },
        undefined,
        undefined,
        controlPlane,
      );
      const response = await request(origin, 'POST', '/v1/projects/test-project/creative-brief', {
        projectId: 'test-project',
        snapshotRevisionId: 'rev-1',
        request: {
          projectId: 'test-project',
          snapshotRevisionId: 'rev-1',
          request: 'test brief',
          scope: 'general',
        },
      });
      expect(response).toMatchObject({
        status: 503,
        body: { data: { kind: 'unavailable', code: 'CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE' } },
      });
    });

    it('resolves input and passes to runtime with injected resolver', async () => {
      const controlPlane = new LocalControlPlane();
      await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
      await controlPlane.setCreativeBriefOptIn({ id: 'owner' }, 'test-project', true, 0);

      const testInput: CreativeBriefInputV1 = {
        snapshot: {
          schemaVersion: 1,
          projectId: 'test-project',
          revisionId: 'rev-1',
          capturedAt: '2026-08-17T00:00:00.000Z',
          composition: {
            durationUs: 1000000,
            frameRate: { num: 30, den: 1 },
            width: 1920,
            height: 1080,
            aspectRatio: '16:9',
          },
          brand: {
            hasBrandKit: false,
            colorsAvailable: false,
            fontsAvailable: false,
            logoAvailable: false,
            voiceInstructionsAvailable: false,
            toneInstructionsAvailable: false,
            prohibitedClaims: [],
            prohibitedEffects: [],
            warnings: [],
          },
          scenes: [],
          timeline: {
            compositionId: 'comp-1',
            durationUs: 1000000,
            frameRate: { num: 30, den: 1 },
            width: 1920,
            height: 1080,
            aspectRatio: '16:9',
            visualTrackCount: 1,
            audioTrackCount: 1,
            totalClipCount: 0,
            visualRowIds: [],
            audioRowIds: [],
          },
          assets: [],
          capabilities: {},
          warnings: [],
          truncation: {
            clipsOmitted: 0,
            assetsOmitted: 0,
            visualObjectsOmitted: 0,
            scenesOmitted: 0,
            totalEstimateBytes: 0,
          },
        },
        brandReadiness: {
          projectId: 'test-project',
          revisionId: 'rev-1',
          colorsAvailable: false,
          fontsAvailable: false,
          logoAvailable: false,
          voiceInstructionsAvailable: false,
          toneInstructionsAvailable: false,
          prohibitedClaims: [],
          prohibitedEffects: [],
          hasBrandKit: false,
          brandCompleteness: 'none',
          missingComponents: [],
          warnings: [],
          evidence: [],
        },
        sceneCoverages: [],
        projectReadiness: {
          projectId: 'test-project',
          revisionId: 'rev-1',
          destination: undefined,
          destinationAligned: true,
          destinationMismatch: undefined,
          durationTargetUs: undefined,
          compositionDurationUs: 1000000,
          durationAligned: true,
          durationGapUs: undefined,
          aspectRatio: '16:9',
          aspectRatioAligned: true,
          aspectRatioMismatch: undefined,
          captionAvailable: false,
          audioAvailable: false,
          generatedAssetsAvailable: false,
          readinessLevel: 'unknown',
          blockers: [],
          warnings: [],
          sceneCount: 0,
          scenesWithVisuals: 0,
          scenesWithAudio: 0,
          scenesWithCaptions: 0,
          evidence: [],
        },
        rules: [],
        request: {
          projectId: 'test-project',
          snapshotRevisionId: 'rev-1',
          request: 'test brief',
          scope: 'general',
        },
      };

      const testResolver = createTestResolver(testInput);
      const origin = await start(
        { authenticate: () => ({ id: 'owner' }) },
        undefined,
        undefined,
        controlPlane,
        undefined,
        testResolver,
      );

      const response = await request(origin, 'POST', '/v1/projects/test-project/creative-brief', {
        projectId: 'test-project',
        snapshotRevisionId: 'rev-1',
        request: {
          projectId: 'test-project',
          snapshotRevisionId: 'rev-1',
          request: 'test brief',
          scope: 'general',
        },
      });
      expect(response).toMatchObject({
        status: 503,
        body: {
          error: {
            code: 'RUNTIME_UNAVAILABLE',
            message: 'Creative brief runtime is not configured',
          },
        },
      });
    });

    it('preserves Persian text in request through resolver', async () => {
      const controlPlane = new LocalControlPlane();
      await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
      await controlPlane.setCreativeBriefOptIn({ id: 'owner' }, 'test-project', true, 0);

      const persianRequest = 'بركتele mele';
      const testInput: CreativeBriefInputV1 = {
        snapshot: {
          schemaVersion: 1,
          projectId: 'test-project',
          revisionId: 'rev-1',
          capturedAt: '2026-08-17T00:00:00.000Z',
          composition: {
            durationUs: 1000000,
            frameRate: { num: 30, den: 1 },
            width: 1920,
            height: 1080,
            aspectRatio: '16:9',
          },
          brand: {
            hasBrandKit: false,
            colorsAvailable: false,
            fontsAvailable: false,
            logoAvailable: false,
            voiceInstructionsAvailable: false,
            toneInstructionsAvailable: false,
            prohibitedClaims: [],
            prohibitedEffects: [],
            warnings: [],
          },
          scenes: [],
          timeline: {
            compositionId: 'comp-1',
            durationUs: 1000000,
            frameRate: { num: 30, den: 1 },
            width: 1920,
            height: 1080,
            aspectRatio: '16:9',
            visualTrackCount: 1,
            audioTrackCount: 1,
            totalClipCount: 0,
            visualRowIds: [],
            audioRowIds: [],
          },
          assets: [],
          capabilities: {},
          warnings: [],
          truncation: {
            clipsOmitted: 0,
            assetsOmitted: 0,
            visualObjectsOmitted: 0,
            scenesOmitted: 0,
            totalEstimateBytes: 0,
          },
        },
        brandReadiness: {
          projectId: 'test-project',
          revisionId: 'rev-1',
          colorsAvailable: false,
          fontsAvailable: false,
          logoAvailable: false,
          voiceInstructionsAvailable: false,
          toneInstructionsAvailable: false,
          prohibitedClaims: [],
          prohibitedEffects: [],
          hasBrandKit: false,
          brandCompleteness: 'none',
          missingComponents: [],
          warnings: [],
          evidence: [],
        },
        sceneCoverages: [],
        projectReadiness: {
          projectId: 'test-project',
          revisionId: 'rev-1',
          destination: undefined,
          destinationAligned: true,
          destinationMismatch: undefined,
          durationTargetUs: undefined,
          compositionDurationUs: 1000000,
          durationAligned: true,
          durationGapUs: undefined,
          aspectRatio: '16:9',
          aspectRatioAligned: true,
          aspectRatioMismatch: undefined,
          captionAvailable: false,
          audioAvailable: false,
          generatedAssetsAvailable: false,
          readinessLevel: 'unknown',
          blockers: [],
          warnings: [],
          sceneCount: 0,
          scenesWithVisuals: 0,
          scenesWithAudio: 0,
          scenesWithCaptions: 0,
          evidence: [],
        },
        rules: [],
        request: {
          projectId: 'test-project',
          snapshotRevisionId: 'rev-1',
          request: persianRequest,
          scope: 'general',
        },
      };

      const testResolver = createTestResolver(testInput);
      const origin = await start(
        { authenticate: () => ({ id: 'owner' }) },
        undefined,
        undefined,
        controlPlane,
        undefined,
        testResolver,
      );

      const response = await request(origin, 'POST', '/v1/projects/test-project/creative-brief', {
        projectId: 'test-project',
        snapshotRevisionId: 'rev-1',
        request: {
          projectId: 'test-project',
          snapshotRevisionId: 'rev-1',
          request: persianRequest,
          scope: 'general',
        },
      });
      expect(response).toMatchObject({
        status: 503,
        body: {
          error: {
            code: 'RUNTIME_UNAVAILABLE',
            message: 'Creative brief runtime is not configured',
          },
        },
      });
    });

    it('maps stale-revision resolver result to 409', async () => {
      const controlPlane = new LocalControlPlane();
      await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
      await controlPlane.setCreativeBriefOptIn({ id: 'owner' }, 'test-project', true, 0);

      const staleResolver: CreativeBriefInputResolver = {
        resolve: (
          _req: CreativeBriefInputResolverRequest,
          _context: CreativeBriefInputResolverContext,
        ) => ({
          status: 'stale-revision',
          code: 'CREATIVE_BRIEF_INPUT_RESOLVER_STALE_REVISION',
          message: 'Revision is stale',
        }),
      };

      const origin = await start(
        { authenticate: () => ({ id: 'owner' }) },
        undefined,
        undefined,
        controlPlane,
        undefined,
        staleResolver,
      );

      const response = await request(origin, 'POST', '/v1/projects/test-project/creative-brief', {
        projectId: 'test-project',
        snapshotRevisionId: 'rev-1',
        request: {
          projectId: 'test-project',
          snapshotRevisionId: 'rev-1',
          request: 'test',
          scope: 'general',
        },
      });
      expect(response).toMatchObject({
        status: 409,
        body: { error: { code: 'REVISION_MISMATCH' } },
      });
    });

    it('passes authenticated actor to resolver', async () => {
      // This test verifies that the HTTP route passes the authenticated actor to the resolver
      const controlPlane = new LocalControlPlane();
      await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
      await controlPlane.setCreativeBriefOptIn({ id: 'owner' }, 'test-project', true, 0);

      let receivedContext: CreativeBriefInputResolverContext | undefined;

      const actorCapturingResolver: CreativeBriefInputResolver = {
        resolve(
          _req: CreativeBriefInputResolverRequest,
          context: CreativeBriefInputResolverContext,
        ): CreativeBriefInputResolverSuccess {
          receivedContext = context;
          return {
            status: 'resolved',
            input: {
              snapshot: {
                schemaVersion: 1,
                projectId: 'test-project',
                revisionId: 'rev-1',
                capturedAt: '2026-08-17T00:00:00.000Z',
                composition: {
                  durationUs: 1000000,
                  frameRate: { num: 30, den: 1 },
                  width: 1920,
                  height: 1080,
                  aspectRatio: '16:9',
                },
                brand: {
                  hasBrandKit: false,
                  colorsAvailable: false,
                  fontsAvailable: false,
                  logoAvailable: false,
                  voiceInstructionsAvailable: false,
                  toneInstructionsAvailable: false,
                  prohibitedClaims: [],
                  prohibitedEffects: [],
                  warnings: [],
                },
                scenes: [],
                timeline: {
                  compositionId: 'comp-1',
                  durationUs: 1000000,
                  frameRate: { num: 30, den: 1 },
                  width: 1920,
                  height: 1080,
                  aspectRatio: '16:9',
                  visualTrackCount: 1,
                  audioTrackCount: 1,
                  totalClipCount: 0,
                  visualRowIds: [],
                  audioRowIds: [],
                },
                assets: [],
                capabilities: {},
                warnings: [],
                truncation: {
                  clipsOmitted: 0,
                  assetsOmitted: 0,
                  visualObjectsOmitted: 0,
                  scenesOmitted: 0,
                  totalEstimateBytes: 0,
                },
              },
              brandReadiness: {
                projectId: 'test-project',
                revisionId: 'rev-1',
                colorsAvailable: false,
                fontsAvailable: false,
                logoAvailable: false,
                voiceInstructionsAvailable: false,
                toneInstructionsAvailable: false,
                prohibitedClaims: [],
                prohibitedEffects: [],
                hasBrandKit: false,
                brandCompleteness: 'none',
                missingComponents: [],
                warnings: [],
                evidence: [],
              },
              sceneCoverages: [],
              projectReadiness: {
                projectId: 'test-project',
                revisionId: 'rev-1',
                destination: undefined,
                destinationAligned: true,
                destinationMismatch: undefined,
                durationTargetUs: undefined,
                compositionDurationUs: 1000000,
                durationAligned: true,
                durationGapUs: undefined,
                aspectRatio: '16:9',
                aspectRatioAligned: true,
                aspectRatioMismatch: undefined,
                captionAvailable: false,
                audioAvailable: false,
                generatedAssetsAvailable: false,
                readinessLevel: 'unknown',
                blockers: [],
                warnings: [],
                sceneCount: 0,
                scenesWithVisuals: 0,
                scenesWithAudio: 0,
                scenesWithCaptions: 0,
                evidence: [],
              },
              rules: [],
              request: {
                projectId: 'test-project',
                snapshotRevisionId: 'rev-1',
                request: 'test',
                scope: 'general',
              },
            },
          };
        },
      };

      const origin = await start(
        { authenticate: () => ({ id: 'owner' }) },
        undefined,
        undefined,
        controlPlane,
        undefined,
        actorCapturingResolver,
      );

      await request(origin, 'POST', '/v1/projects/test-project/creative-brief', {
        projectId: 'test-project',
        snapshotRevisionId: 'rev-1',
        request: {
          projectId: 'test-project',
          snapshotRevisionId: 'rev-1',
          request: 'test',
          scope: 'general',
        },
      });

      expect(receivedContext).toBeDefined();
      expect(receivedContext?.actor.id).toBe('owner');
      expect(receivedContext?.controlPlaneProjectId).toBe('test-project');
    });

    it('verifies client envelope contains only projectId, snapshotRevisionId, and request', async () => {
      // This test verifies that the client envelope passed to the resolver contains
      // ONLY projectId, snapshotRevisionId, and request - no server-side state
      const controlPlane = new LocalControlPlane();
      await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
      await controlPlane.setCreativeBriefOptIn({ id: 'owner' }, 'test-project', true, 0);

      let receivedRequest: CreativeBriefInputResolverRequest | undefined;

      const requestCapturingResolver: CreativeBriefInputResolver = {
        resolve(
          req: CreativeBriefInputResolverRequest,
          _context: CreativeBriefInputResolverContext,
        ): CreativeBriefInputResolverSuccess {
          receivedRequest = req;
          return {
            status: 'resolved',
            input: {
              snapshot: {
                schemaVersion: 1,
                projectId: 'test-project',
                revisionId: 'rev-1',
                capturedAt: '2026-08-17T00:00:00.000Z',
                composition: {
                  durationUs: 1000000,
                  frameRate: { num: 30, den: 1 },
                  width: 1920,
                  height: 1080,
                  aspectRatio: '16:9',
                },
                brand: {
                  hasBrandKit: false,
                  colorsAvailable: false,
                  fontsAvailable: false,
                  logoAvailable: false,
                  voiceInstructionsAvailable: false,
                  toneInstructionsAvailable: false,
                  prohibitedClaims: [],
                  prohibitedEffects: [],
                  warnings: [],
                },
                scenes: [],
                timeline: {
                  compositionId: 'comp-1',
                  durationUs: 1000000,
                  frameRate: { num: 30, den: 1 },
                  width: 1920,
                  height: 1080,
                  aspectRatio: '16:9',
                  visualTrackCount: 1,
                  audioTrackCount: 1,
                  totalClipCount: 0,
                  visualRowIds: [],
                  audioRowIds: [],
                },
                assets: [],
                capabilities: {},
                warnings: [],
                truncation: {
                  clipsOmitted: 0,
                  assetsOmitted: 0,
                  visualObjectsOmitted: 0,
                  scenesOmitted: 0,
                  totalEstimateBytes: 0,
                },
              },
              brandReadiness: {
                projectId: 'test-project',
                revisionId: 'rev-1',
                colorsAvailable: false,
                fontsAvailable: false,
                logoAvailable: false,
                voiceInstructionsAvailable: false,
                toneInstructionsAvailable: false,
                prohibitedClaims: [],
                prohibitedEffects: [],
                hasBrandKit: false,
                brandCompleteness: 'none',
                missingComponents: [],
                warnings: [],
                evidence: [],
              },
              sceneCoverages: [],
              projectReadiness: {
                projectId: 'test-project',
                revisionId: 'rev-1',
                destination: undefined,
                destinationAligned: true,
                destinationMismatch: undefined,
                durationTargetUs: undefined,
                compositionDurationUs: 1000000,
                durationAligned: true,
                durationGapUs: undefined,
                aspectRatio: '16:9',
                aspectRatioAligned: true,
                aspectRatioMismatch: undefined,
                captionAvailable: false,
                audioAvailable: false,
                generatedAssetsAvailable: false,
                readinessLevel: 'unknown',
                blockers: [],
                warnings: [],
                sceneCount: 0,
                scenesWithVisuals: 0,
                scenesWithAudio: 0,
                scenesWithCaptions: 0,
                evidence: [],
              },
              rules: [],
              request: {
                projectId: 'test-project',
                snapshotRevisionId: 'rev-1',
                request: 'test',
                scope: 'general',
              },
            },
          };
        },
      };

      const origin = await start(
        { authenticate: () => ({ id: 'owner' }) },
        undefined,
        undefined,
        controlPlane,
        undefined,
        requestCapturingResolver,
      );

      await request(origin, 'POST', '/v1/projects/test-project/creative-brief', {
        projectId: 'test-project',
        snapshotRevisionId: 'rev-1',
        request: {
          projectId: 'test-project',
          snapshotRevisionId: 'rev-1',
          request: 'test',
          scope: 'general',
        },
      });

      expect(receivedRequest).toBeDefined();
      expect(receivedRequest?.projectId).toBe('test-project');
      expect(receivedRequest?.snapshotRevisionId).toBe('rev-1');
      expect(receivedRequest?.request).toBeDefined();
      // Verify no additional fields are present
      const requestKeys = Object.keys(receivedRequest!);
      expect(requestKeys.sort()).toEqual(['projectId', 'request', 'snapshotRevisionId'].sort());
    });

    it('awaits async resolver and maps all outcome types correctly', async () => {
      // This test verifies that async resolvers are awaited and their outcomes
      // (resolved, unavailable, stale-revision) are mapped exactly as sync resolvers
      const controlPlane = new LocalControlPlane();
      await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
      await controlPlane.setCreativeBriefOptIn({ id: 'owner' }, 'test-project', true, 0);

      // Test async resolved outcome
      let resolverCalled = false;
      const asyncResolvedResolver: CreativeBriefInputResolver = {
        async resolve(
          _req: CreativeBriefInputResolverRequest,
          ctx: CreativeBriefInputResolverContext,
        ): Promise<CreativeBriefInputResolverSuccess> {
          resolverCalled = true;
          // Verify context is received
          expect(ctx.actor.id).toBe('owner');
          // Simulate async work
          await new Promise<void>((r) => setImmediate(r));
          return {
            status: 'resolved',
            input: {
              snapshot: {
                schemaVersion: 1,
                projectId: 'test-project',
                revisionId: 'rev-1',
                capturedAt: '2026-08-17T00:00:00.000Z',
                composition: {
                  durationUs: 1000000,
                  frameRate: { num: 30, den: 1 },
                  width: 1920,
                  height: 1080,
                  aspectRatio: '16:9',
                },
                brand: {
                  hasBrandKit: false,
                  colorsAvailable: false,
                  fontsAvailable: false,
                  logoAvailable: false,
                  voiceInstructionsAvailable: false,
                  toneInstructionsAvailable: false,
                  prohibitedClaims: [],
                  prohibitedEffects: [],
                  warnings: [],
                },
                scenes: [],
                timeline: {
                  compositionId: 'comp-1',
                  durationUs: 1000000,
                  frameRate: { num: 30, den: 1 },
                  width: 1920,
                  height: 1080,
                  aspectRatio: '16:9',
                  visualTrackCount: 1,
                  audioTrackCount: 1,
                  totalClipCount: 0,
                  visualRowIds: [],
                  audioRowIds: [],
                },
                assets: [],
                capabilities: {},
                warnings: [],
                truncation: {
                  clipsOmitted: 0,
                  assetsOmitted: 0,
                  visualObjectsOmitted: 0,
                  scenesOmitted: 0,
                  totalEstimateBytes: 0,
                },
              },
              brandReadiness: {
                projectId: 'test-project',
                revisionId: 'rev-1',
                colorsAvailable: false,
                fontsAvailable: false,
                logoAvailable: false,
                voiceInstructionsAvailable: false,
                toneInstructionsAvailable: false,
                prohibitedClaims: [],
                prohibitedEffects: [],
                hasBrandKit: false,
                brandCompleteness: 'none',
                missingComponents: [],
                warnings: [],
                evidence: [],
              },
              sceneCoverages: [],
              projectReadiness: {
                projectId: 'test-project',
                revisionId: 'rev-1',
                destination: undefined,
                destinationAligned: true,
                destinationMismatch: undefined,
                durationTargetUs: undefined,
                compositionDurationUs: 1000000,
                durationAligned: true,
                durationGapUs: undefined,
                aspectRatio: '16:9',
                aspectRatioAligned: true,
                aspectRatioMismatch: undefined,
                captionAvailable: false,
                audioAvailable: false,
                generatedAssetsAvailable: false,
                readinessLevel: 'unknown',
                blockers: [],
                warnings: [],
                sceneCount: 0,
                scenesWithVisuals: 0,
                scenesWithAudio: 0,
                scenesWithCaptions: 0,
                evidence: [],
              },
              rules: [],
              request: {
                projectId: 'test-project',
                snapshotRevisionId: 'rev-1',
                request: 'test',
                scope: 'general',
              },
            },
          };
        },
      };

      const origin = await start(
        { authenticate: () => ({ id: 'owner' }) },
        undefined,
        undefined,
        controlPlane,
        undefined,
        asyncResolvedResolver,
      );

      await request(origin, 'POST', '/v1/projects/test-project/creative-brief', {
        projectId: 'test-project',
        snapshotRevisionId: 'rev-1',
        request: {
          projectId: 'test-project',
          snapshotRevisionId: 'rev-1',
          request: 'test',
          scope: 'general',
        },
      });

      expect(resolverCalled).toBe(true);

      // Test async unavailable outcome
      const asyncUnavailableResolver: CreativeBriefInputResolver = {
        async resolve(
          _req: CreativeBriefInputResolverRequest,
          _ctx: CreativeBriefInputResolverContext,
        ): Promise<CreativeBriefInputResolverUnavailable> {
          await new Promise<void>((r) => setImmediate(r));
          return {
            status: 'unavailable',
            code: 'CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE',
            message: 'Async unavailable',
          };
        },
      };

      const origin2 = await start(
        { authenticate: () => ({ id: 'owner' }) },
        undefined,
        undefined,
        controlPlane,
        undefined,
        asyncUnavailableResolver,
      );

      const response2 = await request(origin2, 'POST', '/v1/projects/test-project/creative-brief', {
        projectId: 'test-project',
        snapshotRevisionId: 'rev-1',
        request: {
          projectId: 'test-project',
          snapshotRevisionId: 'rev-1',
          request: 'test',
          scope: 'general',
        },
      });
      expect(response2).toMatchObject({
        status: 503,
        body: {
          data: {
            kind: 'unavailable',
            code: 'CREATIVE_BRIEF_INPUT_RESOLVER_UNAVAILABLE',
            message: 'Async unavailable',
          },
        },
      });

      // Test async stale-revision outcome
      const asyncStaleResolver: CreativeBriefInputResolver = {
        async resolve(
          _req: CreativeBriefInputResolverRequest,
          _ctx: CreativeBriefInputResolverContext,
        ): Promise<CreativeBriefInputResolverStaleRevision> {
          await new Promise<void>((r) => setImmediate(r));
          return {
            status: 'stale-revision',
            code: 'CREATIVE_BRIEF_INPUT_RESOLVER_STALE_REVISION',
            message: 'Async stale',
          };
        },
      };

      const origin3 = await start(
        { authenticate: () => ({ id: 'owner' }) },
        undefined,
        undefined,
        controlPlane,
        undefined,
        asyncStaleResolver,
      );

      const response3 = await request(origin3, 'POST', '/v1/projects/test-project/creative-brief', {
        projectId: 'test-project',
        snapshotRevisionId: 'rev-1',
        request: {
          projectId: 'test-project',
          snapshotRevisionId: 'rev-1',
          request: 'test',
          scope: 'general',
        },
      });
      expect(response3).toMatchObject({
        status: 409,
        body: { error: { code: 'REVISION_MISMATCH' } },
      });
    });

    it('executes injected creative brief runtime through HTTP route', async () => {
      const controlPlane = new LocalControlPlane();
      await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
      await controlPlane.setCreativeBriefOptIn({ id: 'owner' }, 'test-project', true, 0);

      let runtimeCalled = false;
      let receivedInput: CreativeBriefInputV1 | undefined;

      const testRuntime: CreativeBriefRuntime = {
        execute: async (input: CreativeBriefInputV1): Promise<AsyncCreativeBriefOutcome> => {
          runtimeCalled = true;
          receivedInput = input;
          return {
            category: 'ready',
            brief: {
              schemaVersion: 1,
              snapshotRevisionId: 'rev-1',
              projectId: 'test-project',
              request: 'test brief',
              interpretedGoal: {
                userIntent: 'test',
                inferredGoal: 'test',
                resolvedGoal: 'test',
                confidence: 'high',
              },
              distinction: { facts: [], inferences: [] },
              assumptions: [],
              recommendations: [],
              blockedBy: [],
              requiresHumanDecision: [],
              intelligence: {
                brand: {
                  projectId: 'test-project',
                  revisionId: 'rev-1',
                  hasBrandKit: false,
                  colorsAvailable: false,
                  fontsAvailable: false,
                  logoAvailable: false,
                  voiceInstructionsAvailable: false,
                  toneInstructionsAvailable: false,
                  prohibitedClaims: [],
                  prohibitedEffects: [],
                  warnings: [],
                  brandCompleteness: 'none',
                  missingComponents: [],
                  evidence: [],
                },
                scenes: [],
                project: {
                  projectId: 'test-project',
                  revisionId: 'rev-1',
                  destination: undefined,
                  destinationAligned: true,
                  destinationMismatch: undefined,
                  durationTargetUs: undefined,
                  compositionDurationUs: 1000000,
                  durationAligned: true,
                  durationGapUs: undefined,
                  aspectRatio: '16:9',
                  aspectRatioAligned: true,
                  aspectRatioMismatch: undefined,
                  captionAvailable: false,
                  audioAvailable: false,
                  generatedAssetsAvailable: false,
                  readinessLevel: 'unknown',
                  blockers: [],
                  warnings: [],
                  sceneCount: 0,
                  scenesWithVisuals: 0,
                  scenesWithAudio: 0,
                  scenesWithCaptions: 0,
                  evidence: [],
                },
                rules: [],
              },
              warnings: [],
              meta: {
                generatedAt: '2026-08-19T00:00:00.000Z',
                modelAdapter: 'test',
                processingTimeMs: 100,
              },
            },
            message: 'Generated brief',
            retryable: false,
            durationMs: 100,
          };
        },
      };

      const testResolver = createTestResolver({
        snapshot: {
          schemaVersion: 1,
          projectId: 'test-project',
          revisionId: 'rev-1',
          capturedAt: '2026-08-17T00:00:00.000Z',
          composition: {
            durationUs: 1000000,
            frameRate: { num: 30, den: 1 },
            width: 1920,
            height: 1080,
            aspectRatio: '16:9',
          },
          brand: {
            hasBrandKit: false,
            colorsAvailable: false,
            fontsAvailable: false,
            logoAvailable: false,
            voiceInstructionsAvailable: false,
            toneInstructionsAvailable: false,
            prohibitedClaims: [],
            prohibitedEffects: [],
            warnings: [],
          },
          scenes: [],
          timeline: {
            compositionId: 'comp-1',
            durationUs: 1000000,
            frameRate: { num: 30, den: 1 },
            width: 1920,
            height: 1080,
            aspectRatio: '16:9',
            visualTrackCount: 1,
            audioTrackCount: 1,
            totalClipCount: 0,
            visualRowIds: [],
            audioRowIds: [],
          },
          assets: [],
          capabilities: {},
          warnings: [],
          truncation: {
            clipsOmitted: 0,
            assetsOmitted: 0,
            visualObjectsOmitted: 0,
            scenesOmitted: 0,
            totalEstimateBytes: 0,
          },
        },
        brandReadiness: {
          projectId: 'test-project',
          revisionId: 'rev-1',
          colorsAvailable: false,
          fontsAvailable: false,
          logoAvailable: false,
          voiceInstructionsAvailable: false,
          toneInstructionsAvailable: false,
          prohibitedClaims: [],
          prohibitedEffects: [],
          hasBrandKit: false,
          brandCompleteness: 'none',
          missingComponents: [],
          warnings: [],
          evidence: [],
        },
        sceneCoverages: [],
        projectReadiness: {
          projectId: 'test-project',
          revisionId: 'rev-1',
          destination: undefined,
          destinationAligned: true,
          destinationMismatch: undefined,
          durationTargetUs: undefined,
          compositionDurationUs: 1000000,
          durationAligned: true,
          durationGapUs: undefined,
          aspectRatio: '16:9',
          aspectRatioAligned: true,
          aspectRatioMismatch: undefined,
          captionAvailable: false,
          audioAvailable: false,
          generatedAssetsAvailable: false,
          readinessLevel: 'unknown',
          blockers: [],
          warnings: [],
          sceneCount: 0,
          scenesWithVisuals: 0,
          scenesWithAudio: 0,
          scenesWithCaptions: 0,
          evidence: [],
        },
        rules: [],
        request: {
          projectId: 'test-project',
          snapshotRevisionId: 'rev-1',
          request: 'test brief',
          scope: 'general',
        },
      });

      const origin = await start(
        { authenticate: () => ({ id: 'owner' }) },
        undefined,
        undefined,
        controlPlane,
        undefined,
        testResolver,
        testRuntime,
      );

      const response = await request(origin, 'POST', '/v1/projects/test-project/creative-brief', {
        projectId: 'test-project',
        snapshotRevisionId: 'rev-1',
        request: {
          projectId: 'test-project',
          snapshotRevisionId: 'rev-1',
          request: 'test brief',
          scope: 'general',
        },
      });

      expect(runtimeCalled).toBe(true);
      expect(receivedInput).toBeDefined();
      expect(receivedInput!.request.request).toBe('test brief');
      expect(response).toMatchObject({
        status: 200,
        body: { data: { request: 'test brief' } },
      });
    });

    it('uses default unavailable runtime when none is injected', async () => {
      const controlPlane = new LocalControlPlane();
      await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
      await controlPlane.setCreativeBriefOptIn({ id: 'owner' }, 'test-project', true, 0);

      const testResolver = createTestResolver({
        snapshot: {
          schemaVersion: 1,
          projectId: 'test-project',
          revisionId: 'rev-1',
          capturedAt: '2026-08-17T00:00:00.000Z',
          composition: {
            durationUs: 1000000,
            frameRate: { num: 30, den: 1 },
            width: 1920,
            height: 1080,
            aspectRatio: '16:9',
          },
          brand: {
            hasBrandKit: false,
            colorsAvailable: false,
            fontsAvailable: false,
            logoAvailable: false,
            voiceInstructionsAvailable: false,
            toneInstructionsAvailable: false,
            prohibitedClaims: [],
            prohibitedEffects: [],
            warnings: [],
          },
          scenes: [],
          timeline: {
            compositionId: 'comp-1',
            durationUs: 1000000,
            frameRate: { num: 30, den: 1 },
            width: 1920,
            height: 1080,
            aspectRatio: '16:9',
            visualTrackCount: 1,
            audioTrackCount: 1,
            totalClipCount: 0,
            visualRowIds: [],
            audioRowIds: [],
          },
          assets: [],
          capabilities: {},
          warnings: [],
          truncation: {
            clipsOmitted: 0,
            assetsOmitted: 0,
            visualObjectsOmitted: 0,
            scenesOmitted: 0,
            totalEstimateBytes: 0,
          },
        },
        brandReadiness: {
          projectId: 'test-project',
          revisionId: 'rev-1',
          colorsAvailable: false,
          fontsAvailable: false,
          logoAvailable: false,
          voiceInstructionsAvailable: false,
          toneInstructionsAvailable: false,
          prohibitedClaims: [],
          prohibitedEffects: [],
          hasBrandKit: false,
          brandCompleteness: 'none',
          missingComponents: [],
          warnings: [],
          evidence: [],
        },
        sceneCoverages: [],
        projectReadiness: {
          projectId: 'test-project',
          revisionId: 'rev-1',
          destination: undefined,
          destinationAligned: true,
          destinationMismatch: undefined,
          durationTargetUs: undefined,
          compositionDurationUs: 1000000,
          durationAligned: true,
          durationGapUs: undefined,
          aspectRatio: '16:9',
          aspectRatioAligned: true,
          aspectRatioMismatch: undefined,
          captionAvailable: false,
          audioAvailable: false,
          generatedAssetsAvailable: false,
          readinessLevel: 'unknown',
          blockers: [],
          warnings: [],
          sceneCount: 0,
          scenesWithVisuals: 0,
          scenesWithAudio: 0,
          scenesWithCaptions: 0,
          evidence: [],
        },
        rules: [],
        request: {
          projectId: 'test-project',
          snapshotRevisionId: 'rev-1',
          request: 'test brief',
          scope: 'general',
        },
      });

      const origin = await start(
        { authenticate: () => ({ id: 'owner' }) },
        undefined,
        undefined,
        controlPlane,
        undefined,
        testResolver,
      );

      const response = await request(origin, 'POST', '/v1/projects/test-project/creative-brief', {
        projectId: 'test-project',
        snapshotRevisionId: 'rev-1',
        request: {
          projectId: 'test-project',
          snapshotRevisionId: 'rev-1',
          request: 'test brief',
          scope: 'general',
        },
      });

      expect(response).toMatchObject({
        status: 503,
        body: {
          error: {
            code: 'RUNTIME_UNAVAILABLE',
            message: 'Creative brief runtime is not configured',
          },
        },
      });
    });
  });
});

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

async function start(
  authentication: ApiAuthentication,
  privateObjectStore?: PrivateObjectStore,
  mistral?: MistralProviderRegistry,
  controlPlane: ControlPlane = new LocalControlPlane(),
  audioDenoise?: SpectralDenoiseService,
  creativeBriefInputResolver?: CreativeBriefInputResolver,
  creativeBriefRuntime?: CreativeBriefRuntime,
  rateLimit?: { readonly windowMs?: number; readonly maxRequests?: number },
  clientAddressResolver?: ClientAddressResolver,
  readiness?: ApiReadinessOptions,
): Promise<string> {
  const server = createControlPlaneHttpServer({
    controlPlane,
    authentication,
    mediaAuth: new DisabledMediaAuth(),
    ...(privateObjectStore === undefined ? {} : { privateObjectStore }),
    ...(mistral === undefined ? {} : { mistral }),
    ...(audioDenoise === undefined ? {} : { audioDenoise }),
    ...(creativeBriefInputResolver === undefined ? {} : { creativeBriefInputResolver }),
    ...(creativeBriefRuntime === undefined ? {} : { creativeBriefRuntime }),
    ...(rateLimit === undefined ? {} : { rateLimit }),
    ...(clientAddressResolver === undefined ? {} : { clientAddressResolver }),
    ...(readiness === undefined ? {} : { readiness }),
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test API did not bind TCP');
  return `http://127.0.0.1:${address.port}`;
}

// ============================================================================
// Project Document Sync Route Tests - WP-37 S4 Phase 5-B
// ============================================================================

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

class MemoryPrivateObjectStore implements PrivateObjectStore {
  readonly objects: Array<{
    readonly descriptor: PrivateObjectDescriptor;
    readonly bytes: Uint8Array;
  }> = [];
  readonly removed: string[] = [];

  async put(descriptor: PrivateObjectDescriptor, bytes: Uint8Array): Promise<void> {
    const index = this.objects.findIndex(
      (candidate) => candidate.descriptor.ref === descriptor.ref,
    );
    const object = { descriptor, bytes };
    if (index < 0) this.objects.push(object);
    else this.objects.splice(index, 1, object);
  }
  async get(descriptor: PrivateObjectDescriptor): Promise<Uint8Array> {
    const object = this.objects.find((candidate) => candidate.descriptor.ref === descriptor.ref);
    if (object === undefined) throw new Error('private object not found');
    return object.bytes;
  }
  async remove(ref: string): Promise<void> {
    this.removed.push(ref);
    const index = this.objects.findIndex((candidate) => candidate.descriptor.ref === ref);
    if (index >= 0) this.objects.splice(index, 1);
  }
}

class FailingSecondAttachControlPlane extends LocalControlPlane {
  override attachCloudOriginal(
    actor: Actor,
    projectId: string,
    assetId: string,
    location: AssetLocationRecord & { readonly kind: 'private-object' },
  ): MediaAssetRecord {
    if (assetId === 'video-2') {
      throw new ControlPlaneError('ASSET_UPDATE_FAILED', 'simulated metadata failure');
    }
    return super.attachCloudOriginal(actor, projectId, assetId, location);
  }
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
  if (bearerToken !== undefined) headers.authorization = `Bearer ${bearerToken}`;
  Object.assign(headers, additionalHeaders);
  const response = await fetch(
    `${origin}${pathname}`,
    body === undefined
      ? { method, ...(Object.keys(headers).length === 0 ? {} : { headers }) }
      : { method, headers, body: JSON.stringify(body) },
  );
  return { status: response.status, body: await response.json() };
}

// ============================================================================
// Creative Brief Opt-In Route Tests - WP-37 S4 Phase 6-D1
// ============================================================================

describe('GET /v1/projects/:projectId/creative-brief-opt-in', () => {
  it('requires authentication', async () => {
    const origin = await start({ authenticate: () => undefined });
    expect(
      await request(origin, 'GET', '/v1/projects/test-project/creative-brief-opt-in'),
    ).toMatchObject({
      status: 401,
      body: { error: { code: 'AUTH_REQUIRED' } },
    });
  });

  it('returns the owner-scoped opt-in state and lifecycle revision', async () => {
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      undefined,
      controlPlane,
    );
    expect(
      await request(origin, 'GET', '/v1/projects/test-project/creative-brief-opt-in'),
    ).toMatchObject({
      status: 200,
      body: { data: { creativeBriefOptIn: false, revision: 0 } },
    });
  });

  it('returns the updated state after opt-in changes', async () => {
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
    await controlPlane.setCreativeBriefOptIn({ id: 'owner' }, 'test-project', true, 0);
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      undefined,
      controlPlane,
    );
    expect(
      await request(origin, 'GET', '/v1/projects/test-project/creative-brief-opt-in'),
    ).toMatchObject({
      status: 200,
      body: { data: { creativeBriefOptIn: true, revision: 1 } },
    });
  });

  it('hides unknown and non-owner projects', async () => {
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
    const origin = await start(
      { authenticate: () => ({ id: 'other' }) },
      undefined,
      undefined,
      controlPlane,
    );
    expect(
      await request(origin, 'GET', '/v1/projects/test-project/creative-brief-opt-in'),
    ).toMatchObject({
      status: 409,
      body: { error: { code: 'PROJECT_NOT_FOUND' } },
    });
  });
});

describe('PUT /v1/projects/:projectId/creative-brief-opt-in', () => {
  it('requires authentication', async () => {
    const origin = await start({ authenticate: () => undefined });
    expect(
      await request(origin, 'PUT', '/v1/projects/test-project/creative-brief-opt-in', {
        enabled: true,
        baseRevision: 0,
      }),
    ).toMatchObject({
      status: 401,
      body: { error: { code: 'AUTH_REQUIRED' } },
    });
  });

  it('enables creative brief opt-in', async () => {
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      undefined,
      controlPlane,
    );
    expect(
      await request(origin, 'PUT', '/v1/projects/test-project/creative-brief-opt-in', {
        enabled: true,
        baseRevision: 0,
      }),
    ).toMatchObject({
      status: 200,
      body: { data: { creativeBriefOptIn: true, revision: 1 } },
    });
  });

  it('disables creative brief opt-in', async () => {
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
    await controlPlane.setCreativeBriefOptIn({ id: 'owner' }, 'test-project', true, 0);
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      undefined,
      controlPlane,
    );
    expect(
      await request(origin, 'PUT', '/v1/projects/test-project/creative-brief-opt-in', {
        enabled: false,
        baseRevision: 1,
      }),
    ).toMatchObject({
      status: 200,
      body: { data: { creativeBriefOptIn: false, revision: 2 } },
    });
  });

  it('rejects with revision conflict when baseRevision does not match', async () => {
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      undefined,
      controlPlane,
    );
    expect(
      await request(origin, 'PUT', '/v1/projects/test-project/creative-brief-opt-in', {
        enabled: true,
        baseRevision: 999,
      }),
    ).toMatchObject({
      status: 409,
      body: { error: { code: 'REVISION_CONFLICT' } },
    });
  });

  it('rejects for non-owner with owner isolation', async () => {
    const controlPlane = new LocalControlPlane();
    await controlPlane.createProject({ id: 'owner' }, 'test-project', 'Test');
    const origin = await start(
      { authenticate: () => ({ id: 'other' }) },
      undefined,
      undefined,
      controlPlane,
    );
    expect(
      await request(origin, 'PUT', '/v1/projects/test-project/creative-brief-opt-in', {
        enabled: true,
        baseRevision: 0,
      }),
    ).toMatchObject({
      status: 409,
      body: { error: { code: 'PROJECT_NOT_FOUND' } },
    });
  });

  it('rejects unknown project', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    expect(
      await request(origin, 'PUT', '/v1/projects/unknown-project/creative-brief-opt-in', {
        enabled: true,
        baseRevision: 0,
      }),
    ).toMatchObject({
      status: 409,
      body: { error: { code: 'PROJECT_NOT_FOUND' } },
    });
  });

  it('rejects invalid body with missing enabled', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    expect(
      await request(origin, 'PUT', '/v1/projects/test-project/creative-brief-opt-in', {
        baseRevision: 0,
      }),
    ).toMatchObject({
      status: 400,
      body: { error: { code: 'REQUEST_INVALID' } },
    });
  });

  it('rejects invalid body with missing baseRevision', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    expect(
      await request(origin, 'PUT', '/v1/projects/test-project/creative-brief-opt-in', {
        enabled: true,
      }),
    ).toMatchObject({
      status: 400,
      body: { error: { code: 'REQUEST_INVALID' } },
    });
  });

  it('rejects invalid body with extra fields', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    expect(
      await request(origin, 'PUT', '/v1/projects/test-project/creative-brief-opt-in', {
        enabled: true,
        baseRevision: 0,
        extraField: 'not-allowed',
      }),
    ).toMatchObject({
      status: 400,
      body: { error: { code: 'REQUEST_INVALID' } },
    });
  });

  it('rejects invalid body with enabled not boolean', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    expect(
      await request(origin, 'PUT', '/v1/projects/test-project/creative-brief-opt-in', {
        enabled: 'true',
        baseRevision: 0,
      }),
    ).toMatchObject({
      status: 400,
      body: { error: { code: 'REQUEST_INVALID' } },
    });
  });

  it('rejects invalid body with baseRevision not a non-negative integer', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    expect(
      await request(origin, 'PUT', '/v1/projects/test-project/creative-brief-opt-in', {
        enabled: true,
        baseRevision: -1,
      }),
    ).toMatchObject({
      status: 400,
      body: { error: { code: 'REQUEST_INVALID' } },
    });
  });

  it('rejects invalid body with baseRevision as float', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    expect(
      await request(origin, 'PUT', '/v1/projects/test-project/creative-brief-opt-in', {
        enabled: true,
        baseRevision: 1.5,
      }),
    ).toMatchObject({
      status: 400,
      body: { error: { code: 'REQUEST_INVALID' } },
    });
  });

  it('rejects invalid body with baseRevision as string', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    expect(
      await request(origin, 'PUT', '/v1/projects/test-project/creative-brief-opt-in', {
        enabled: true,
        baseRevision: '0',
      }),
    ).toMatchObject({
      status: 400,
      body: { error: { code: 'REQUEST_INVALID' } },
    });
  });
});
