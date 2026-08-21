import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { once } from 'node:events';
import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalControlPlane, type ControlPlane } from './control-plane.js';
import { createControlPlaneHttpServer, type ApiAuthentication } from './http-server.js';
import { DisabledMediaAuth } from './media-auth.js';
import { MemoryMistralInvocationLedger, MistralProviderRegistry } from './mistral-provider.js';
import { ProviderApprovalService } from './provider-approval.js';
import type { PrivateObjectDescriptor, PrivateObjectStore } from './private-object-store.js';
import type { WorkerResultReceiptV1, WorkerJobType } from '@joy-media/job-protocol';
import { PostgresControlPlane } from './postgres-control-plane.js';
import type { ProductionRunAuthority, ProductionRunRecordV1 } from './production-runs.js';

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
    const approvals = new ProviderApprovalService();
    const registry = new MistralProviderRegistry(
      'test-only-mistral-secret',
      new MemoryMistralInvocationLedger(),
      approvals,
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
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      registry,
      undefined,
      approvals,
    );
    const base = {
      model: 'mistral-small-latest',
      messages: [{ role: 'user', content: 'Do not persist this prompt.' }],
      idempotencyKey: 'mistral-1',
      privacyMode: 'ask-before-remote',
      approvedRemoteProcessing: true,
      approvedSpend: true,
    };
    const approvalRequired = await request(origin, 'POST', '/v1/providers/mistral/complete', base);
    expect(approvalRequired).toMatchObject({
      status: 409,
      body: { error: { code: 'PROVIDER_APPROVAL_REQUIRED', preflight: { providerId: 'mistral' } } },
    });
    const preflight = (
      approvalRequired.body as {
        error: {
          preflight: {
            actorId?: string;
            providerId: string;
            capability: 'llm.complete';
            requestDigest: string;
          };
        };
      }
    ).error.preflight;
    const providerApprovalGrant = approvals.createGrant({
      actorId: 'owner',
      providerId: preflight.providerId,
      capability: preflight.capability,
      requestDigest: preflight.requestDigest,
      expiresAt: '2026-12-31T00:00:00.000Z',
      costCap: { amount: '0.00', currency: 'USD' },
      grantId: 'grant-mistral-1',
    });
    const approved = { ...base, providerApprovalGrant };
    const first = await request(origin, 'POST', '/v1/providers/mistral/complete', approved);
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
    const retried = await request(origin, 'POST', '/v1/providers/mistral/complete', approved);
    expect(retried).toEqual(first);
    expect(
      await request(origin, 'POST', '/v1/providers/mistral/complete', {
        ...approved,
        messages: [{ role: 'user', content: 'Different prompt.' }],
      }),
    ).toMatchObject({
      status: 409,
      body: { error: { code: 'PROVIDER_APPROVAL_REPLAY_REJECTED' } },
    });
    expect(calls).toBe(1);
    expect(JSON.stringify(first.body)).not.toContain('test-only-mistral-secret');
    expect(JSON.stringify(first.body)).not.toContain('Do not persist this prompt.');
    const audit = await request(origin, 'GET', '/v1/providers/approvals/audit');
    expect(audit).toMatchObject({
      status: 200,
      body: {
        data: expect.arrayContaining([
          expect.objectContaining({ status: 'denied', reason: 'approval-required' }),
          expect.objectContaining({ status: 'succeeded', approvalGrantId: 'grant-mistral-1' }),
        ]),
      },
    });
    expect(JSON.stringify(audit.body)).not.toContain('Do not persist this prompt.');
  });

  it('requires shared remote approval before Edge TTS can run', async () => {
    const approvals = new ProviderApprovalService();
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      undefined,
      undefined,
      approvals,
    );

    const blocked = await request(origin, 'POST', '/v1/providers/speech/synthesize', {
      text: 'Do not send before approval.',
      language: 'en-US',
      engine: 'edge-tts',
      idempotencyKey: 'tts-edge-1',
      privacyMode: 'ask-before-remote',
    });

    expect(blocked).toMatchObject({
      status: 409,
      body: {
        error: {
          code: 'PROVIDER_APPROVAL_REQUIRED',
          preflight: { providerId: 'edge-tts', capability: 'speech.synthesize' },
        },
      },
    });
    const audit = await request(origin, 'GET', '/v1/providers/approvals/audit');
    expect(audit).toMatchObject({
      status: 200,
      body: { data: [expect.objectContaining({ status: 'denied', reason: 'approval-required' })] },
    });
    expect(JSON.stringify(audit.body)).not.toContain('Do not send before approval.');
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
      /path|pairing|session|access_token|https?:\/\//i,
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

  it('brokers a Worker thumbnail through private storage only with sync consent, then streams verified bytes to the owner', async () => {
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

    const denied = await upload();
    expect(denied.status).toBe(409);
    expect(store.removed).toEqual([`thumb-j-${sha256.slice(0, 16)}`]);
    expect(store.objects).toHaveLength(0);

    await request(origin, 'POST', '/v1/projects/p/asset-sync', { enabled: true });
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
    expect(content.url).toContain('/content');
    expect(content.url).not.toContain('parspack');
  });

  it('accepts only typed Worker job payloads and leases them back over HTTP', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' });
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
      { capabilities: ['render.export'] },
      workerToken,
    );

    const typedJob = {
      id: 'render-export-1',
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
    };
    expect(await request(origin, 'POST', '/v1/projects/p/jobs', typedJob)).toMatchObject({
      status: 201,
      body: { data: typedJob },
    });
    expect(await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken)).toMatchObject({
      status: 200,
      body: {
        data: {
          id: 'render-export-1',
          payload: typedJob.payload,
          requirements: typedJob.requirements,
          idempotencyKey: 'idem-render-export-1',
          maxAttempts: 5,
        },
      },
    });
    expect(
      await request(
        origin,
        'POST',
        '/v1/workers/w/jobs/render-export-1/complete',
        {
          result: {
            kind: 'render.export',
            reportRef: 'report-render-export-1',
            outputRef: 'output-render-export-1',
            sha256: 'a'.repeat(64),
            bytes: 2048,
            qualityReport: {
              version: 1,
              promiseId: 'promise-1',
              checkedAt: '2026-08-21T00:00:00.000Z',
              artifact: {
                outputRef: 'output-render-export-1',
                sha256: 'a'.repeat(64),
                bytes: 2048,
              },
              facts: {},
              findings: [{ code: 'delivery', status: 'pass', message: 'delivery passed' }],
            },
          },
        },
        workerToken,
      ),
    ).toMatchObject({
      status: 200,
      body: {
        data: {
          derivative: {
            kind: 'render.export',
            reportRef: 'report-render-export-1',
            outputRef: 'output-render-export-1',
            qualityReport: {
              findings: [{ code: 'delivery', status: 'pass', message: 'delivery passed' }],
            },
          },
        },
      },
    });
    expect(
      await request(origin, 'POST', '/v1/projects/p/jobs', {
        ...typedJob,
        id: 'bad-render-export',
        payload: { ...typedJob.payload, projectRef: 'C:\\private\\project.json' },
      }),
    ).toMatchObject({ status: 409, body: { error: { code: 'WORKER_JOB_INVALID' } } });
  });

  it('exposes authenticated PostgreSQL production-run create, list, get, respond, and cancel routes', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      undefined,
      controlPlane,
    );
    await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Production' });
    const authority: ProductionRunAuthority = { principalId: 'owner', role: 'owner' };
    const record = parkedRecord('run-api', 'approval-api', authority);

    expect(
      await request(origin, 'POST', '/v1/projects/p/production-runs', {
        runKey: 'run-key-api',
        authority,
        record,
      }),
    ).toMatchObject({
      status: 201,
      body: { data: { runId: 'run-api', state: 'parked', updatedSeq: 2 } },
    });
    expect(await request(origin, 'GET', '/v1/projects/p/production-runs?limit=1')).toMatchObject({
      status: 200,
      body: { data: { runs: [{ runId: 'run-api' }] } },
    });
    expect(await request(origin, 'GET', '/v1/projects/p/production-runs/run-api')).toMatchObject({
      status: 200,
      body: { data: { runId: 'run-api', approvals: [{ approvalId: 'approval-api' }] } },
    });
    expect(
      await request(
        origin,
        'POST',
        '/v1/projects/p/production-runs/run-api/approvals/approval-api/respond',
        {
          approved: true,
          responseRef: 'response-api',
          response: { approved: [{ assetId: 'asset-1' }] },
          authority,
          expectedUpdatedSeq: 2,
        },
      ),
    ).toMatchObject({
      status: 200,
      body: {
        data: {
          duplicate: false,
          record: {
            updatedSeq: 3,
            approvals: [
              {
                state: 'approved',
                responseRef: 'response-api',
                response: { approved: [{ assetId: 'asset-1' }] },
              },
            ],
          },
        },
      },
    });
    expect(
      await request(
        origin,
        'POST',
        '/v1/projects/p/production-runs/run-api/approvals/approval-api/respond',
        {
          approved: true,
          responseRef: 'response-api',
          response: { approved: [{ assetId: 'asset-1' }] },
          authority,
          expectedUpdatedSeq: 2,
        },
      ),
    ).toMatchObject({
      status: 200,
      body: {
        data: {
          duplicate: true,
          record: {
            updatedSeq: 3,
          },
        },
      },
    });
    expect(
      await request(
        origin,
        'POST',
        '/v1/projects/p/production-runs/run-api/approvals/approval-api/respond',
        {
          approved: true,
          responseRef: 'response-api-role-mismatch',
          response: { approved: true },
          authority: { principalId: 'owner', role: 'reviewer' },
        },
      ),
    ).toMatchObject({ status: 409, body: { error: { code: 'AUTHORITY_INVALID' } } });
    expect(
      await request(origin, 'POST', '/v1/projects/p/production-runs/run-api/cancel', {
        authority,
        expectedUpdatedSeq: 2,
      }),
    ).toMatchObject({ status: 409, body: { error: { code: 'REVISION_CONFLICT' } } });

    const cancelRecord = queuedRecord('run-api-cancel', authority);
    await request(origin, 'POST', '/v1/projects/p/production-runs', {
      runKey: 'run-key-api-cancel',
      authority,
      record: cancelRecord,
    });
    const mixedAuthorityRecord = parkedRecord('run-api-mixed', 'approval-api-mixed', authority);
    expect(
      await request(origin, 'POST', '/v1/projects/p/production-runs', {
        runKey: 'run-key-api-mixed',
        authority,
        record: {
          ...mixedAuthorityRecord,
          approvals: [
            {
              ...mixedAuthorityRecord.approvals[0]!,
              authority: { principalId: 'reviewer-2', role: 'reviewer' },
            },
          ],
        },
      }),
    ).toMatchObject({ status: 409, body: { error: { code: 'AUTHORITY_REQUIRED' } } });
    expect(
      await request(origin, 'POST', '/v1/projects/p/production-runs', {
        runKey: 'run-key-api-file',
        authority,
        record: queuedRecord('run-api-file', authority, {
          nodes: [
            {
              nodeId: 'node-1',
              type: 'render.review',
              category: 'review',
              state: 'waiting_for_input',
              attempts: 1,
              deterministic: false,
              reused: false,
              logs: [
                {
                  seq: 1,
                  nodeId: 'node-1',
                  attempt: 1,
                  level: 'info',
                  message: 'file:///private/final.mp4',
                },
              ],
              artifactIds: [],
            },
          ],
        }),
      }),
    ).toMatchObject({ status: 409, body: { error: { code: 'PRODUCTION_RUN_INVALID' } } });
    expect(
      await request(origin, 'POST', '/v1/projects/p/production-runs', {
        runKey: 'run-key-api-nested-raw',
        authority,
        record: queuedRecord('run-api-nested-raw', authority, {
          checkpoint: {
            export: {
              opaqueToken: 'QUJD/'.repeat(32),
            },
          },
        }),
      }),
    ).toMatchObject({ status: 409, body: { error: { code: 'PRODUCTION_RUN_INVALID' } } });
    expect(
      await request(origin, 'POST', '/v1/projects/p/production-runs', {
        runKey: 'run-key-api-nested-alnum-raw',
        authority,
        record: queuedRecord('run-api-nested-alnum-raw', authority, {
          checkpoint: {
            export: {
              opaqueToken: 'A'.repeat(128),
            },
          },
        }),
      }),
    ).toMatchObject({ status: 409, body: { error: { code: 'PRODUCTION_RUN_INVALID' } } });
    expect(
      await request(origin, 'POST', '/v1/projects/p/production-runs/run-api-cancel/cancel', {
        authority,
        expectedUpdatedSeq: 1,
      }),
    ).toMatchObject({
      status: 200,
      body: { data: { state: 'canceled', events: [{}, { type: 'run.canceled' }] } },
    });
    expect(
      JSON.stringify(await request(origin, 'GET', '/v1/projects/p/production-runs/run-api')),
    ).not.toMatch(/C:\\|mediaBase64|https?:\/\//);
    await pool.end();
  });

  it('accepts every AI Worker receipt variant through the completion route', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' });
    await request(origin, 'POST', '/v1/projects/p/assets', {
      id: 'asset-source-1',
      kind: 'image',
      displayName: 'source.png',
      sha256: '2'.repeat(64),
      bytes: 2048,
      descriptor: { mimeType: 'image/png', width: 1024, height: 1024 },
      locations: [{ kind: 'opfs-cache', ref: 'source-image-1' }],
    });
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
    const variants: readonly {
      readonly type: Extract<
        WorkerJobType,
        | 'image.comfy'
        | 'audio.ml-denoise'
        | 'text.lm-studio'
        | 'text.openrouter'
        | 'video.runway'
        | 'edit.higgsfield'
      >;
      readonly receipt: WorkerResultReceiptV1;
      readonly assetId?: string;
    }[] = [
      {
        type: 'image.comfy',
        assetId: 'asset-source-1',
        receipt: {
          kind: 'image.comfy',
          assetId: 'asset-source-1',
          sha256: '9'.repeat(64),
          bytes: 1024,
          localRef: 'gpu-image-comfy-1',
          descriptor: { mimeType: 'image/png', width: 1024, height: 1024 },
        },
      },
      {
        type: 'audio.ml-denoise',
        assetId: 'asset-source-1',
        receipt: {
          kind: 'audio.ml-denoise',
          assetId: 'asset-source-1',
          sha256: '8'.repeat(64),
          bytes: 1536,
          localRef: 'gpu-audio-denoise-1',
          descriptor: { mimeType: 'audio/wav' },
        },
      },
      {
        type: 'text.lm-studio',
        receipt: {
          kind: 'text.lm-studio',
          resultRef: 'ai-text-local-1',
          sha256: 'd'.repeat(64),
          bytes: 64,
          model: 'local-model',
        },
      },
      {
        type: 'text.openrouter',
        receipt: {
          kind: 'text.openrouter',
          resultRef: 'ai-text-remote-1',
          sha256: 'e'.repeat(64),
          bytes: 128,
          model: 'openrouter-model',
        },
      },
      {
        type: 'video.runway',
        receipt: {
          kind: 'video.runway',
          assetId: 'asset-video-1',
          sha256: 'f'.repeat(64),
          bytes: 8192,
          localRef: 'ai-video-runway-1',
          descriptor: { mimeType: 'video/mp4', width: 1280, height: 720 },
          model: 'gen4',
        },
      },
      {
        type: 'edit.higgsfield',
        receipt: {
          kind: 'edit.higgsfield',
          assetId: 'asset-edit-1',
          sha256: '1'.repeat(64),
          bytes: 4096,
          localRef: 'ai-edit-higgsfield-1',
          descriptor: { mimeType: 'image/png', width: 1024, height: 1024 },
          model: 'higgsfield-default',
        },
      },
    ];
    await request(
      origin,
      'POST',
      '/v1/workers/w/hello',
      { capabilities: variants.map((variant) => variant.type), assetIds: ['asset-source-1'] },
      workerToken,
    );

    for (const [index, variant] of variants.entries()) {
      const job = {
        id: `ai-job-${index + 1}`,
        type: variant.type,
        ...(variant.assetId === undefined ? {} : { assetId: variant.assetId }),
        payload: {
          prompt: `Generate variant ${index + 1}`,
          ...(variant.type === 'edit.higgsfield' ? { imageAssetId: 'asset-source-1' } : {}),
        },
        requirements: {
          capabilities: [variant.type],
          privacy:
            variant.type === 'text.lm-studio' ? ('local-only' as const) : ('remote-api' as const),
        },
        idempotencyKey: `idem-ai-job-${index + 1}`,
        maxAttempts: 2,
      };
      expect(await request(origin, 'POST', '/v1/projects/p/jobs', job)).toMatchObject({
        status: 201,
        body: { data: { id: job.id, type: variant.type } },
      });
      expect(await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken)).toMatchObject({
        status: 200,
        body: { data: { id: job.id, type: variant.type } },
      });
      expect(
        await request(
          origin,
          'POST',
          `/v1/workers/w/jobs/${job.id}/complete`,
          { result: variant.receipt },
          workerToken,
        ),
      ).toMatchObject({
        status: 200,
        body: {
          data: {
            id: job.id,
            state: 'completed',
            derivative: { kind: variant.type },
          },
        },
      });
    }
  });

  it('rejects completion without a result for every Worker job type', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' });
    await request(origin, 'POST', '/v1/projects/p/assets', {
      id: 'asset-source-1',
      kind: 'image',
      displayName: 'source.png',
      sha256: '2'.repeat(64),
      bytes: 2048,
      descriptor: { mimeType: 'image/png', width: 1024, height: 1024 },
      locations: [{ kind: 'opfs-cache', ref: 'source-image-1' }],
    });
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
    const variants: ReadonlyArray<{
      readonly id: string;
      readonly type: WorkerJobType;
      readonly job: Record<string, unknown>;
    }> = [
      {
        id: 'job-thumb',
        type: 'asset.thumbnail',
        job: { id: 'job-thumb', type: 'asset.thumbnail', assetId: 'asset-source-1' },
      },
      {
        id: 'job-comfy',
        type: 'image.comfy',
        job: { id: 'job-comfy', type: 'image.comfy', assetId: 'asset-source-1' },
      },
      {
        id: 'job-denoise',
        type: 'audio.ml-denoise',
        job: { id: 'job-denoise', type: 'audio.ml-denoise', assetId: 'asset-source-1' },
      },
      { id: 'job-export', type: 'render.export', job: { id: 'job-export', type: 'render.export' } },
      {
        id: 'job-inspect',
        type: 'render.inspect',
        job: { id: 'job-inspect', type: 'render.inspect' },
      },
      {
        id: 'job-text-local',
        type: 'text.lm-studio',
        job: { id: 'job-text-local', type: 'text.lm-studio' },
      },
      {
        id: 'job-text-remote',
        type: 'text.openrouter',
        job: { id: 'job-text-remote', type: 'text.openrouter' },
      },
      {
        id: 'job-video',
        type: 'video.runway',
        job: { id: 'job-video', type: 'video.runway' },
      },
      {
        id: 'job-edit',
        type: 'edit.higgsfield',
        job: { id: 'job-edit', type: 'edit.higgsfield' },
      },
    ];
    await request(
      origin,
      'POST',
      '/v1/workers/w/hello',
      { capabilities: variants.map((variant) => variant.type), assetIds: ['asset-source-1'] },
      workerToken,
    );

    for (const variant of variants) {
      expect(await request(origin, 'POST', '/v1/projects/p/jobs', variant.job)).toMatchObject({
        status: 201,
        body: { data: { id: variant.id, type: variant.type } },
      });
      expect(await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken)).toMatchObject({
        status: 200,
        body: { data: { id: variant.id, type: variant.type } },
      });
      expect(
        await request(origin, 'POST', `/v1/workers/w/jobs/${variant.id}/complete`, {}, workerToken),
      ).toMatchObject({
        status: 400,
        body: { error: { code: 'REQUEST_INVALID' } },
      });
      expect(
        await request(
          origin,
          'POST',
          `/v1/workers/w/jobs/${variant.id}/fail`,
          { error: 'canceled' },
          workerToken,
        ),
      ).toMatchObject({
        status: 200,
        body: { data: { state: 'canceled' } },
      });
    }
  });

  it('rejects mismatched AI media receipts over HTTP', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' });
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
      { capabilities: ['video.runway'] },
      workerToken,
    );
    await request(origin, 'POST', '/v1/projects/p/jobs', {
      id: 'ai-mismatch-1',
      type: 'video.runway',
      payload: { prompt: 'Generate a video' },
      requirements: { capabilities: ['video.runway'], privacy: 'remote-api' },
      idempotencyKey: 'idem-ai-mismatch-1',
      maxAttempts: 2,
    });
    await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken);

    expect(
      await request(
        origin,
        'POST',
        '/v1/workers/w/jobs/ai-mismatch-1/complete',
        {
          result: {
            kind: 'video.runway',
            assetId: 'asset-video-mismatch-1',
            sha256: '7'.repeat(64),
            bytes: 4096,
            localRef: 'ai-mismatch-video-1',
            descriptor: { mimeType: 'image/png', width: 1024, height: 1024 },
          },
        },
        workerToken,
      ),
    ).toMatchObject({
      status: 400,
      body: { error: { code: 'REQUEST_INVALID' } },
    });
  });
});

async function start(
  authentication: ApiAuthentication,
  privateObjectStore?: PrivateObjectStore,
  mistral?: MistralProviderRegistry,
  controlPlane?: ControlPlane,
  providerApprovals?: ProviderApprovalService,
): Promise<string> {
  const server = createControlPlaneHttpServer({
    controlPlane: controlPlane ?? new LocalControlPlane(),
    authentication,
    mediaAuth: new DisabledMediaAuth(),
    ...(privateObjectStore === undefined ? {} : { privateObjectStore }),
    ...(mistral === undefined ? {} : { mistral }),
    ...(providerApprovals === undefined ? {} : { providerApprovals }),
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
    this.objects.push({ descriptor, bytes });
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

function queuedRecord(
  runId: string,
  authority: ProductionRunAuthority,
  overrides: Partial<ProductionRunRecordV1> = {},
): ProductionRunRecordV1 {
  return {
    recordVersion: 1,
    runId,
    workflowId: 'wf-production',
    workflowVersion: '1.0.0',
    projectRevision: 'rev-1',
    state: 'queued',
    checkpointRevision: 0,
    links: {},
    events: [
      {
        eventVersion: 1,
        seq: 1,
        type: 'run.queued',
        state: 'queued',
        actor: authority,
        checkpointRevision: 0,
        message: 'production run queued',
      },
    ],
    approvals: [],
    nodes: [],
    createdSeq: 1,
    updatedSeq: 1,
    ...overrides,
  };
}

function parkedRecord(
  runId: string,
  approvalId: string,
  authority: ProductionRunAuthority,
): ProductionRunRecordV1 {
  return queuedRecord(runId, authority, {
    state: 'parked',
    checkpointRevision: 1,
    events: [
      {
        eventVersion: 1,
        seq: 1,
        type: 'run.parked',
        state: 'parked',
        actor: authority,
        checkpointRevision: 1,
        message: 'production run parked',
      },
      {
        eventVersion: 1,
        seq: 2,
        type: 'approval.requested',
        state: 'parked',
        nodeId: 'review',
        approvalId,
        checkpointRevision: 1,
        message: 'approve-render',
      },
    ],
    approvals: [
      {
        approvalVersion: 1,
        approvalId,
        nodeId: 'review',
        kind: 'approve-render',
        prompt: 'Approve final?',
        requestPayload: { diffRef: 'asset-diff-1' },
        state: 'pending',
        requestedSeq: 2,
      },
    ],
    nodes: [
      {
        nodeId: 'review',
        type: 'render.review',
        category: 'review',
        state: 'waiting_for_input',
        attempts: 1,
        deterministic: false,
        reused: false,
        pendingApprovalId: approvalId,
        logs: [],
        artifactIds: [],
      },
    ],
    updatedSeq: 2,
  });
}
