import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../store/local-database.js';
import { createJobOrchestrator } from './job-orchestrator.js';
import {
  MAX_AI_REQUEST_BYTES,
  MAX_LOCAL_SOURCE_BYTES,
  startLocalJobApi,
  type LocalAiRequest,
  type LocalAiResult,
  type LocalJobApi,
} from './local-job-api.js';

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
  let aiRequests: LocalAiRequest[];
  let aiReply: LocalAiResult;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'joy-job-api-'));
    derivativeDirectory = join(dir, 'derivatives');
    database = new LocalDatabase({ filePath: join(dir, 'jobs.sqlite') });
    reportedSourceSize = SOURCE.length;
    aiRequests = [];
    aiReply = { ok: true, text: '{"choices":[]}' };
    api = await startLocalJobApi({
      orchestrator: createJobOrchestrator({ store: database.jobDispatch }),
      derivativeDirectory,
      sourceSize: async () => reportedSourceSize,
      readSource: async (refId) => {
        if (refId !== 'ref-1') throw new Error('unknown ref');
        return SOURCE;
      },
      completeAi: async (request) => {
        aiRequests.push(request);
        return aiReply;
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

  async function queueThumbnailAndLease(
    profileId?: string,
  ): Promise<{ id: string; leaseToken: string }> {
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
      profileId,
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
    reportedSourceSize = MAX_LOCAL_SOURCE_BYTES + 1;
    const response = await call(`/v1/workers/${WORKER}/jobs/job-http/source`, {
      headers: { 'x-joy-lease-token': leased.leaseToken },
    });
    expect(response.status).toBe(413);
  });

  it('serves a source of exactly the local route limit, the largest original that registers', async () => {
    const leased = await queueThumbnailAndLease();
    reportedSourceSize = MAX_LOCAL_SOURCE_BYTES;
    const response = await call(`/v1/workers/${WORKER}/jobs/job-http/source`, {
      headers: { 'x-joy-lease-token': leased.leaseToken },
    });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(SOURCE);
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

  describe('AI completion route (PLAN-v4 §6b)', () => {
    const aiPath = `/v1/workers/${WORKER}/ai/complete`;
    const messages = [{ role: 'user', content: 'hi' }];

    it('refuses a wrong token before reading the body', async () => {
      const response = await call(aiPath, { method: 'POST', body: '{}' }, 'wrong-token');
      expect(response.status).toBe(401);
      expect(aiRequests).toEqual([]);
    });

    it('completes for the profile attached to the job, and ignores a profile named in the body', async () => {
      await queueThumbnailAndLease('prof-saved');
      const response = await postJson(aiPath, {
        jobId: 'job-http',
        profileId: 'attacker-profile',
        messages,
        params: { temperature: 0.1, profileId: 'attacker-profile', model: 'attacker-model' },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ data: { text: '{"choices":[]}' } });
      expect(aiRequests).toHaveLength(1);
      expect(aiRequests[0]).toMatchObject({
        workerId: WORKER,
        jobId: 'job-http',
        profileId: 'prof-saved',
      });
      expect(aiRequests[0]?.body).toMatchObject({ messages, temperature: 0.1 });
      expect(JSON.stringify(aiRequests[0]?.body)).not.toContain('attacker');
    });

    it('answers 403 when the job is leased to another Worker', async () => {
      await queueThumbnailAndLease('prof-saved');
      const response = await postJson('/v1/workers/worker-other/ai/complete', {
        jobId: 'job-http',
        messages,
      });
      expect(response.status).toBe(403);
      expect(aiRequests).toEqual([]);
    });

    it('answers 409 once the job has finished, and never calls a provider', async () => {
      const leased = await queueThumbnailAndLease('prof-saved');
      await postJson(`/v1/workers/${WORKER}/jobs/job-http/fail`, {
        error: 'stopped',
        leaseToken: leased.leaseToken,
      });
      const response = await postJson(aiPath, { jobId: 'job-http', messages });
      expect(response.status).toBe(409);
      expect(aiRequests).toEqual([]);
    });

    it('answers 409 for a job that has no AI profile', async () => {
      await queueThumbnailAndLease();
      const response = await postJson(aiPath, { jobId: 'job-http', messages });
      expect(response.status).toBe(409);
      expect(aiRequests).toEqual([]);
    });

    it('answers 404 for an unknown job and 422 for a malformed job id', async () => {
      await queueThumbnailAndLease('prof-saved');
      expect((await postJson(aiPath, { jobId: 'missing-job', messages })).status).toBe(404);
      expect((await postJson(aiPath, { jobId: 'bad/id', messages })).status).toBe(422);
      expect(aiRequests).toEqual([]);
    });

    it('answers 413 for a request over the AI size limit, before any provider call', async () => {
      await queueThumbnailAndLease('prof-saved');
      const oversized = JSON.stringify({
        jobId: 'job-http',
        messages: [{ role: 'user', content: 'x'.repeat(MAX_AI_REQUEST_BYTES) }],
      });
      const response = await call(aiPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: oversized,
      });
      expect(response.status).toBe(413);
      expect(aiRequests).toEqual([]);
    });

    it('passes the broker failure status and message through, with no credential', async () => {
      await queueThumbnailAndLease('prof-saved');
      aiReply = { ok: false, status: 502, message: 'The provider could not be reached.' };
      const response = await postJson(aiPath, { jobId: 'job-http', messages });
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).toContain('The provider could not be reached.');
      expect(text).not.toContain(TOKEN);
    });

    it('answers 409 for a cancelled job, and for a job whose lease has expired', async () => {
      await queueThumbnailAndLease('prof-saved');
      const held = database.jobDispatch.get('job-http');
      if (held === undefined) throw new Error('expected the leased job');
      database.jobDispatch.save({ ...held, cancelRequested: true });
      expect((await postJson(aiPath, { jobId: 'job-http', messages })).status).toBe(409);
      database.jobDispatch.save({
        ...held,
        cancelRequested: false,
        leaseExpiresAt: '2000-01-01T00:00:00.000Z',
      });
      expect((await postJson(aiPath, { jobId: 'job-http', messages })).status).toBe(409);
      expect(aiRequests).toEqual([]);
    });
  });
});
