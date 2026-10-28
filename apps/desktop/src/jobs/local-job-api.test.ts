import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../store/local-database.js';
import { createJobOrchestrator } from './job-orchestrator.js';
import { startLocalJobApi, type LocalJobApi } from './local-job-api.js';

const WORKER = 'worker-http';
const TOKEN = 'test-token-0123456789';
const SOURCE = Buffer.from('source-bytes');
const DERIVATIVE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

describe('local job API', () => {
  let dir: string;
  let database: LocalDatabase;
  let api: LocalJobApi;
  let derivativeDirectory: string;

  let reportedSourceSize: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'joy-job-api-'));
    derivativeDirectory = join(dir, 'derivatives');
    database = new LocalDatabase({ filePath: join(dir, 'jobs.sqlite') });
    reportedSourceSize = SOURCE.length;
    api = await startLocalJobApi({
      orchestrator: createJobOrchestrator({ store: database.jobDispatch }),
      derivativeDirectory,
      sourceSize: async () => reportedSourceSize,
      readSource: async (refId) => {
        if (refId !== 'ref-1') throw new Error('unknown ref');
        return SOURCE;
      },
      token: TOKEN,
    });
  });

  afterEach(async () => {
    await api.close();
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function call(path: string, init: RequestInit = {}, token = TOKEN): Promise<Response> {
    return fetch(`${api.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  }

  function postJson(path: string, body: unknown): Promise<Response> {
    return call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function queueThumbnailAndLease(): Promise<{ id: string; leaseToken: string }> {
    await postJson(`/v1/workers/${WORKER}/hello`, {
      capabilities: ['asset.thumbnail'],
      assetIds: [],
    });
    database.jobDispatch.insert({
      id: 'job-http',
      kind: 'derivative:thumbnail',
      jobType: 'asset.thumbnail',
      refId: 'ref-1',
      status: 'queued',
      createdAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-21T00:00:00.000Z',
      error: undefined,
      progress: 0,
      attempts: 0,
      workerId: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      cancelRequested: false,
      derivative: undefined,
      resultJson: undefined,
    });
    const response = await postJson(`/v1/workers/${WORKER}/leases`, { durationMs: 30_000 });
    const body = (await response.json()) as { data: { id: string; leaseToken: string } };
    return body.data;
  }

  it('binds only to the loopback address on a random port', () => {
    expect(api.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(api.workerEnv).toEqual({
      JOY_MEDIA_API_URL: api.url,
      JOY_MEDIA_WORKER_LOCAL_TOKEN: TOKEN,
    });
  });

  it('refuses every request without the per-run token', async () => {
    const response = await call(
      `/v1/workers/${WORKER}/hello`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capabilities: [], assetIds: [] }),
      },
      'wrong-token',
    );
    expect(response.status).toBe(401);
    const missing = await fetch(`${api.url}/v1/workers/${WORKER}/leases`, { method: 'POST' });
    expect(missing.status).toBe(401);
  });

  it('answers in the { data } envelope the Worker client parses, and leases a queued thumbnail', async () => {
    const leased = await queueThumbnailAndLease();
    expect(leased).toMatchObject({ id: 'job-http', leaseToken: expect.any(String) });
  });

  it('returns null from lease when nothing is queued', async () => {
    await postJson(`/v1/workers/${WORKER}/hello`, {
      capabilities: ['asset.thumbnail'],
      assetIds: [],
    });
    const response = await postJson(`/v1/workers/${WORKER}/leases`, { durationMs: 30_000 });
    expect(await response.json()).toEqual({ data: null });
  });

  it('sends a queued render export its payload with the lease', async () => {
    await postJson(`/v1/workers/${WORKER}/hello`, {
      capabilities: ['render.export'],
      assetIds: [],
    });
    database.jobDispatch.insert({
      id: 'job-export',
      kind: 'render',
      jobType: 'render.export',
      refId: 'project-1',
      status: 'queued',
      createdAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-21T00:00:00.000Z',
      error: undefined,
      progress: 0,
      attempts: 0,
      workerId: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      cancelRequested: false,
      derivative: undefined,
      resultJson: undefined,
      payloadJson: JSON.stringify({ schemaVersion: 1, frameCount: 3 }),
    });
    const response = await postJson(`/v1/workers/${WORKER}/leases`, { durationMs: 30_000 });
    const body = (await response.json()) as { data: { type: string; payload: unknown } };
    expect(body.data).toMatchObject({
      type: 'render.export',
      payload: { schemaVersion: 1, frameCount: 3 },
    });
  });

  it('serves the source bytes only to the Worker holding the lease', async () => {
    const leased = await queueThumbnailAndLease();
    const owner = await call(`/v1/workers/${WORKER}/jobs/job-http/source`, {
      headers: { 'x-joy-lease-token': leased.leaseToken },
    });
    expect(owner.status).toBe(200);
    expect(Buffer.from(await owner.arrayBuffer())).toEqual(SOURCE);

    const stranger = await call(`/v1/workers/${WORKER}/jobs/job-http/source`, {
      headers: { 'x-joy-lease-token': 'not-the-lease' },
    });
    expect(stranger.status).toBe(409);
  });

  it('refuses to read a source larger than the local route limit, before reading it', async () => {
    const leased = await queueThumbnailAndLease();
    reportedSourceSize = 512 * 1024 * 1024 + 1;
    const response = await call(`/v1/workers/${WORKER}/jobs/job-http/source`, {
      headers: { 'x-joy-lease-token': leased.leaseToken },
    });
    expect(response.status).toBe(413);
  });

  it('rejects a derivative whose bytes do not match the reported digest and stores nothing', async () => {
    const leased = await queueThumbnailAndLease();
    const response = await call(`/v1/workers/${WORKER}/jobs/job-http/derivative`, {
      method: 'POST',
      headers: {
        'content-type': 'image/jpeg',
        'x-joy-lease-token': leased.leaseToken,
        'x-joy-sha256': 'deadbeef',
        'x-joy-bytes': String(DERIVATIVE.length),
      },
      body: DERIVATIVE,
    });
    expect(response.status).toBe(422);
    expect(existsSync(derivativeDirectory) ? readdirSync(derivativeDirectory) : []).toEqual([]);
  });

  it('accepts a verified derivative, stores it, and completes the job only with a matching digest', async () => {
    const leased = await queueThumbnailAndLease();
    const sha256 = createHash('sha256').update(DERIVATIVE).digest('hex');
    const upload = await call(`/v1/workers/${WORKER}/jobs/job-http/derivative`, {
      method: 'POST',
      headers: {
        'content-type': 'image/jpeg',
        'x-joy-lease-token': leased.leaseToken,
        'x-joy-sha256': sha256,
        'x-joy-bytes': String(DERIVATIVE.length),
      },
      body: DERIVATIVE,
    });
    expect(upload.status).toBe(200);
    const [stored] = readdirSync(derivativeDirectory);
    expect(stored).toBeDefined();
    expect(readFileSync(join(derivativeDirectory, stored ?? ''))).toEqual(DERIVATIVE);

    const completed = await postJson(`/v1/workers/${WORKER}/jobs/job-http/complete`, {
      result: { kind: 'asset.thumbnail', assetId: 'ref-1', sha256, bytes: DERIVATIVE.length },
      leaseToken: leased.leaseToken,
    });
    expect(completed.status).toBe(200);
    expect(database.jobDispatch.get('job-http')).toMatchObject({ status: 'done', progress: 100 });
  });

  it('turns a Worker-reported failure into a failed job with its message', async () => {
    const leased = await queueThumbnailAndLease();
    const response = await postJson(`/v1/workers/${WORKER}/jobs/job-http/fail`, {
      error: 'ffmpeg exited 1',
      leaseToken: leased.leaseToken,
    });
    expect(response.status).toBe(200);
    expect(database.jobDispatch.get('job-http')).toMatchObject({
      status: 'failed',
      error: 'ffmpeg exited 1',
    });
  });
});
