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
  type Actor,
  type AssetLocationRecord,
  type ControlPlane,
  type MediaAssetRecord,
} from './control-plane.js';
import { createControlPlaneHttpServer, type ApiAuthentication } from './http-server.js';
import { DisabledMediaAuth } from './media-auth.js';
import { renderFixture, verifyExport } from '@joy-media/export-core';
import { MemoryMistralInvocationLedger, MistralProviderRegistry } from './mistral-provider.js';
import type { PrivateObjectDescriptor, PrivateObjectStore } from './private-object-store.js';
import { MAX_DENOISE_JSON_BYTES, type SpectralDenoiseResult } from './spectral-denoise.js';
import {
  MemorySpectralDenoiseInvocationLedger,
  SpectralDenoiseService,
} from './spectral-denoise-service.js';

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
    await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken);

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
    await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken);
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
});

async function start(
  authentication: ApiAuthentication,
  privateObjectStore?: PrivateObjectStore,
  mistral?: MistralProviderRegistry,
  controlPlane: ControlPlane = new LocalControlPlane(),
  audioDenoise?: SpectralDenoiseService,
): Promise<string> {
  const server = createControlPlaneHttpServer({
    controlPlane,
    authentication,
    mediaAuth: new DisabledMediaAuth(),
    ...(privateObjectStore === undefined ? {} : { privateObjectStore }),
    ...(mistral === undefined ? {} : { mistral }),
    ...(audioDenoise === undefined ? {} : { audioDenoise }),
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test API did not bind TCP');
  return `http://127.0.0.1:${address.port}`;
}

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
