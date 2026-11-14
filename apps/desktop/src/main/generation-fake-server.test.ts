/**
 * Integration suite for MiniMax generation (T-C08). The real provider broker (and with it the T-C02 adapters) and the
 * real job manager (T-C03) run here against the loopback fake in tooling/qa/stub-model/generation-server.mjs. The only
 * substitutions are the transport (a fetch that sends the MiniMax origin to the fake) and the file download (a fetch
 * that sends the fake media host to the fake), so the bytes travel over real HTTP. Real ffprobe checks the files.
 * ffprobe must be on PATH; without it the probe tests fail, as they should.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemorySecretStore, isPrivateOrInternalHost } from '@joy-media/provider-sdk';
import {
  createProviderBroker,
  endpointBindingDigest,
  type BrokerProfile,
  type ProviderFetch,
} from './providers/provider-broker.js';
import {
  createGenerationJobs,
  createPinnedGenerationDownloader,
  probeGeneratedMedia,
  type GenerationDownload,
  type GenerationJobs,
} from './generation-jobs.js';
import type { GenerationJobRecord, GenerationJobStore } from '../store/generation-job-store.js';
import type { ProviderProfile } from '../store/local-database.js';

// The fake lives in tooling/qa (outside this package, which is built with composite projects), so it is loaded by a
// relative path at run time instead of imported. Its shapes are declared here; generation-server.d.mts documents them.
type RouteLabel =
  | 'image'
  | 'image-legacy'
  | 'video-create'
  | 'video-create-legacy'
  | 'video-query'
  | 'video-query-legacy'
  | 'video-cancel'
  | 'file-link'
  | 'download';

interface ScriptedReply {
  readonly status?: number;
  readonly json?: unknown;
  readonly text?: string;
  readonly drop?: boolean;
  readonly body?: Uint8Array;
  readonly contentLength?: number;
  readonly dropAfterBytes?: number;
}

interface LoggedRequest {
  readonly label: RouteLabel | 'unknown';
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly authorizationOk: boolean;
  readonly body: unknown;
}

interface GenerationServer {
  readonly origin: string;
  readonly requests: readonly LoggedRequest[];
  reply(label: RouteLabel, ...replies: readonly ScriptedReply[]): void;
  pending(label: RouteLabel): number;
  close(): Promise<void>;
}

interface FakeServerModule {
  readonly FAKE_MEDIA_HOST: string;
  reply(spec: ScriptedReply): ScriptedReply;
  startGenerationServer(options: { readonly expectedKey: string }): Promise<GenerationServer>;
}

const FAKE_SERVER_MODULE = '../../../../tooling/qa/stub-model/generation-server.mjs';
const fake = (await import(/* @vite-ignore */ FAKE_SERVER_MODULE)) as FakeServerModule;
const { FAKE_MEDIA_HOST, reply, startGenerationServer } = fake;

const NOW = Date.UTC(2026, 10, 14);
const KEY = 'not-a-real-key-for-tests';
/**
 * The MiniMax origin is only the profile binding (its endpoint digest) and the origin fetchToFake matches on. It is never
 * contacted: fetchToFake sends this origin to the fake and rejects every other origin.
 */
const MINIMAX_ORIGIN = 'https://api.minimax.io';
const MINIMAX_BASE = `${MINIMAX_ORIGIN}/v1`;
// A 1x1 PNG, as the picture reply carries it in base64. It is a real file that ffprobe classifies as a picture.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');
// A two-frame MP4 from the repository's own fixtures: a real video that ffprobe classifies as a video.
const VIDEO_BYTES = readFileSync(
  fileURLToPath(
    new URL(
      '../../../../packages/test-fixtures/live-director-generated/single-frame-flash.mp4',
      import.meta.url,
    ),
  ),
);

const PROFILE: ProviderProfile = {
  id: 'profile-1',
  provider: 'minimax',
  baseUrl: MINIMAX_BASE,
  modelId: 'chat-model',
  secretHandleId: 'secret-handle',
  createdAt: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
};

const BROKER_PROFILE: BrokerProfile = {
  id: PROFILE.id,
  provider: 'minimax',
  baseUrl: MINIMAX_BASE,
  modelId: 'chat-model',
  secretHandleId: PROFILE.secretHandleId,
  bindingDigest: endpointBindingDigest(PROFILE.id, MINIMAX_ORIGIN, '/v1'),
  bindingSecretDigest: 'version-1',
};

const TERMINAL_STATES: readonly GenerationJobRecord['state'][] = [
  'completed',
  'failed',
  'cancelled',
  'abandoned-locally',
  'timed-out',
];

function memoryStore(): GenerationJobStore {
  const rows = new Map<string, GenerationJobRecord>();
  return {
    save(job) {
      rows.set(job.id, { ...job });
    },
    get(id) {
      const job = rows.get(id);
      return job === undefined ? undefined : { ...job };
    },
    list() {
      return [...rows.values()].map((job) => ({ ...job }));
    },
  };
}

/** The MiniMax origin goes to the fake; any other host is a bug in the suite, so it fails loudly. */
function fetchToFake(server: GenerationServer): ProviderFetch {
  return (url, init) => {
    const target = new URL(url);
    if (target.origin !== MINIMAX_ORIGIN) {
      return Promise.reject(new Error(`the suite does not send ${target.origin}`));
    }
    return fetch(`${server.origin}${target.pathname}${target.search}`, init);
  };
}

/**
 * Stands in for the pinned downloader, which refuses loopback addresses by design (see the test of the real one below).
 * It mirrors the real downloader's contract: HTTPS on the media host only, and a failed status is a failed download.
 */
async function downloadFromFake(
  server: GenerationServer,
  url: string,
  signal: AbortSignal,
): Promise<GenerationDownload> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.origin !== FAKE_MEDIA_HOST) {
    throw new Error('The video download address was refused.');
  }
  const response = await fetch(`${server.origin}${target.pathname}`, {
    method: 'GET',
    redirect: 'manual',
    signal,
  });
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('The video download could not be read.');
  }
  const lengthText = response.headers.get('content-length');
  return {
    body: Readable.fromWeb(response.body as NodeReadableStream),
    ...(lengthText === null ? {} : { contentLength: Number(lengthText) }),
  };
}

interface RigOptions {
  readonly maxImageBytes?: number;
  readonly maxVideoBytes?: number;
  readonly videoTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

interface RestartOptions {
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
}

interface Rig {
  readonly server: GenerationServer;
  readonly manager: GenerationJobs;
  readonly store: GenerationJobStore;
  readonly generatedDirectory: string;
  readonly broker: ReturnType<typeof createProviderBroker>;
  /** A new job manager on the same store, broker and folder: what the app builds after a restart. */
  restart(extra?: RestartOptions): GenerationJobs;
}

/** Undo steps for every rig, run last in first out after each test. Each is pushed as soon as its resource exists. */
const cleanups: Array<() => void | Promise<void>> = [];

async function rig(options: RigOptions = {}): Promise<Rig> {
  const server = await startGenerationServer({ expectedKey: KEY });
  cleanups.push(() => server.close());
  const generatedDirectory = mkdtempSync(path.join(tmpdir(), 'joy-generation-suite-'));
  cleanups.push(() => rmSync(generatedDirectory, { recursive: true, force: true }));
  const secrets = createMemorySecretStore();
  await secrets.set(BROKER_PROFILE.secretHandleId, KEY);
  const broker = createProviderBroker({
    store: {
      getProfile: (id) => (id === BROKER_PROFILE.id ? BROKER_PROFILE : undefined),
      isDisabledLegacy: () => false,
      markCredentialUnavailable: () => undefined,
      secretVersion: () => 'version-1',
    },
    secrets,
    fetch: fetchToFake(server),
    resolveHost: async () => [],
    now: () => NOW,
  });
  const store = memoryStore();
  let nextId = 0;
  const newId = (): string => {
    nextId += 1;
    return `job-${nextId}`;
  };
  const build = (extra: RestartOptions = {}): GenerationJobs => {
    const manager = createGenerationJobs({
      store,
      getProfile: (id) => (id === PROFILE.id ? PROFILE : undefined),
      broker,
      generatedDirectory,
      download: (url, signal) => downloadFromFake(server, url, signal),
      probe: probeGeneratedMedia,
      pollIntervalMs: extra.pollIntervalMs ?? options.pollIntervalMs ?? 5,
      videoTimeoutMs: options.videoTimeoutMs ?? 60_000,
      newId,
      ...(extra.now === undefined ? {} : { now: extra.now }),
      ...(options.maxImageBytes === undefined ? {} : { maxImageBytes: options.maxImageBytes }),
      ...(options.maxVideoBytes === undefined ? {} : { maxVideoBytes: options.maxVideoBytes }),
    });
    cleanups.push(() => manager.stop());
    return manager;
  };
  return {
    server,
    manager: build(),
    store,
    generatedDirectory,
    broker,
    restart: build,
  };
}

afterEach(async () => {
  for (const undo of cleanups.splice(0).reverse()) await undo();
});

/**
 * Polls the job record until `done` holds, or fails with the last state the job was in. `manager` defaults to the rig's
 * own manager; a restart test passes the manager it built after the restart.
 */
async function waitForJob(
  made: Rig,
  id: string,
  done: (job: GenerationJobRecord) => boolean,
  manager: GenerationJobs = made.manager,
): Promise<GenerationJobRecord> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const job = manager.status(id);
    if (job !== undefined && done(job)) return job;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out; last state ${job?.state ?? 'none'}${job?.error === undefined ? '' : `: ${job.error}`}`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

const finished = (job: GenerationJobRecord): boolean => TERMINAL_STATES.includes(job.state);

function labels(made: Rig): string[] {
  return made.server.requests.map((request) => request.label);
}

/** A JSON reply that holds a base64 picture, in the H3 shape. */
function pictureReply(base64: string = PNG_BASE64) {
  return reply({ json: { base_resp: { status_code: 0 }, data: [{ b64_json: base64 }] } });
}

describe('generation against the fake MiniMax server: pictures', () => {
  it('saves a base64 picture from the current route, checked by ffprobe and hashed', async () => {
    const made = await rig();
    made.server.reply('image', pictureReply());

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'image',
      prompt: 'a red square',
    });
    const job = await waitForJob(made, started.id, finished);

    expect(job).toMatchObject({ state: 'completed', kind: 'image', route: 'current' });
    expect(job.filePath).toBeDefined();
    const saved = readFileSync(job.filePath ?? '');
    expect(saved.equals(PNG_BYTES)).toBe(true);
    expect(job.sha256).toBe(createHash('sha256').update(PNG_BYTES).digest('hex'));
    expect(labels(made)).toEqual(['image']);
    expect(made.server.requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/images/generations',
      authorizationOk: true,
      body: { model: 'MiniMax-H3-Image', prompt: 'a red square', response_format: 'b64_json' },
    });
  });

  it('falls back to the legacy picture route only when the current one is missing', async () => {
    const made = await rig();
    made.server.reply('image', reply({ status: 404, json: { error: 'not found' } }));
    made.server.reply(
      'image-legacy',
      reply({ json: { base_resp: { status_code: 0 }, data: { image_base64: [PNG_BASE64] } } }),
    );

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'image',
      prompt: 'a red square',
    });
    const job = await waitForJob(made, started.id, finished);

    expect(job).toMatchObject({ state: 'completed', route: 'legacy', model: 'image-01' });
    expect(labels(made)).toEqual(['image', 'image-legacy']);
  });

  it('refuses a link-only picture reply and never fetches the link', async () => {
    const made = await rig();
    made.server.reply(
      'image',
      reply({ json: { data: [{ url: `${FAKE_MEDIA_HOST}/download/picture.png` }] } }),
    );

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'image',
      prompt: 'a red square',
    });
    const job = await waitForJob(made, started.id, finished);

    expect(job.state).toBe('failed');
    expect(job.error).toContain('link-only');
    expect(labels(made)).toEqual(['image']);
  });

  it('stops a picture reply too large for the picture limit before it is decoded', async () => {
    const made = await rig({ maxImageBytes: 1024 });
    // 70 KB of picture bytes (a PNG signature first, so the reply is a picture): more base64 than the reply check
    // allows for a 1 KB limit.
    const hugePicture = Buffer.concat([PNG_BYTES, Buffer.alloc(70_000, 0)]);
    made.server.reply('image', pictureReply(hugePicture.toString('base64')));

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'image',
      prompt: 'a red square',
    });
    const job = await waitForJob(made, started.id, finished);

    expect(job).toMatchObject({ state: 'failed' });
    expect(job.error).toContain('larger than the 1024-byte limit');
    expect(job.filePath).toBeUndefined();
  });

  it('stops a picture that passes the reply check but is over the limit while it is saved', async () => {
    const made = await rig({ maxImageBytes: 1024 });
    const bigPicture = Buffer.concat([PNG_BYTES, Buffer.alloc(2048, 0)]);
    made.server.reply('image', pictureReply(bigPicture.toString('base64')));

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'image',
      prompt: 'a red square',
    });
    const job = await waitForJob(made, started.id, finished);

    expect(job.state).toBe('failed');
    expect(job.error).toContain('larger than the 1024-byte limit');
    expect(readdirSync(made.generatedDirectory)).toEqual([]);
  });

  it('a dropped connection while a picture is asked for fails the job, with no fallback route', async () => {
    const made = await rig();
    made.server.reply('image', reply({ drop: true }));

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'image',
      prompt: 'a red square',
    });
    const job = await waitForJob(made, started.id, finished);

    expect(job.state).toBe('failed');
    expect(labels(made)).toEqual(['image']);
  });
});

describe('generation against the fake MiniMax server: typed refusals', () => {
  it.each([
    ['a refused key (401)', reply({ status: 401, json: {} }), 'AUTH_FAILED'],
    [
      'a key whose plan does not allow the model (403)',
      reply({ status: 403, json: {} }),
      'GENERATION_NOT_ALLOWED',
    ],
    [
      'a balance error sent with a 200',
      reply({ json: { base_resp: { status_code: 1008, status_msg: 'insufficient balance' } } }),
      'GENERATION_QUOTA',
    ],
    ['a rate limit (429)', reply({ status: 429, json: {} }), 'GENERATION_QUOTA'],
    [
      'a prompt the provider refuses',
      reply({ json: { base_resp: { status_code: 1026, status_msg: 'sensitive' } } }),
      'GENERATION_BAD_PROMPT',
    ],
    ['a server error (500)', reply({ status: 500, json: {} }), 'GENERATION_REJECTED'],
  ])('maps %s to its typed code, with no fallback', async (_name, scripted, code) => {
    const made = await rig();
    made.server.reply('image', scripted);

    const result = await made.broker.generateImage({
      profileId: PROFILE.id,
      prompt: 'a red square',
    });

    expect(result).toMatchObject({ ok: false, code });
    expect(labels(made)).toEqual(['image']);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('shows the app plan message on the job, not the raw reply', async () => {
    const made = await rig();
    made.server.reply('image', reply({ status: 403, json: { detail: 'plan text from provider' } }));

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'image',
      prompt: 'a red square',
    });
    const job = await waitForJob(made, started.id, finished);

    expect(job.error).toBe(
      'This key does not allow that model. Check the plan on the provider account.',
    );
    expect(JSON.stringify(made.manager.list())).not.toContain('plan text from provider');
  });

  it('refuses a reply that echoes the key: the job fails and the key is in no record', async () => {
    const made = await rig();
    made.server.reply('image', reply({ status: 403, json: { echo: KEY } }));

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'image',
      prompt: 'a red square',
    });
    const job = await waitForJob(made, started.id, finished);

    expect(job.state).toBe('failed');
    expect(JSON.stringify(made.manager.list())).not.toContain(KEY);
    expect(JSON.stringify(job)).not.toContain(KEY);
  });
});

describe('generation against the fake MiniMax server: videos', () => {
  it('runs a current-route video from queued to a saved, probed file', async () => {
    const made = await rig();
    made.server.reply('video-create', reply({ json: { task_id: 'task-1' } }));
    made.server.reply(
      'video-query',
      reply({ json: { status: 'queued' } }),
      reply({ json: { status: 'running' } }),
      reply({ json: { status: 'succeeded', file_id: 'file-1' } }),
    );
    made.server.reply('download', reply({ body: VIDEO_BYTES }));

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    const job = await waitForJob(made, started.id, finished);

    expect(job).toMatchObject({ state: 'completed', kind: 'video', route: 'current' });
    expect(job.filePath).toMatch(/\.(mp4|mov)$/);
    expect(readFileSync(job.filePath ?? '').equals(VIDEO_BYTES)).toBe(true);
    expect(labels(made)).toEqual([
      'video-create',
      'video-query',
      'video-query',
      'video-query',
      'file-link',
      'download',
    ]);
    expect(made.server.requests.find((request) => request.label === 'video-create')).toMatchObject({
      method: 'POST',
      path: '/v2/video_generation',
      authorizationOk: true,
      body: { model: 'MiniMax-H3-Lite', prompt: 'a slow pan', resolution: '480P', duration: 4 },
    });
    const keyed = made.server.requests.filter((request) => request.label !== 'download');
    expect(keyed.every((request) => request.authorizationOk)).toBe(true);
  });

  it('runs a legacy-route video when the current route is missing, and asks the legacy query', async () => {
    const made = await rig();
    made.server.reply('video-create', reply({ status: 404, json: {} }));
    made.server.reply('video-create-legacy', reply({ json: { task_id: 'legacy-1' } }));
    made.server.reply(
      'video-query-legacy',
      reply({ json: { status: 'running' } }),
      reply({ json: { status: 'success', file_id: 'file-2' } }),
    );
    made.server.reply('download', reply({ body: VIDEO_BYTES }));

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    const job = await waitForJob(made, started.id, finished);

    expect(job).toMatchObject({ state: 'completed', route: 'legacy', model: 'MiniMax-Hailuo-02' });
    expect(made.server.requests.find((request) => request.label === 'video-create-legacy')).toMatchObject({
      method: 'POST',
      path: '/v1/video_generation',
      authorizationOk: true,
      body: { model: 'MiniMax-Hailuo-02', prompt: 'a slow pan', resolution: '512P', duration: 6 },
    });
    expect(labels(made)).toContain('video-create-legacy');
    expect(labels(made)).toContain('video-query-legacy');
    expect(labels(made)).not.toContain('video-cancel');
  });

  it('marks a video the provider reports failed, after the status is read', async () => {
    const made = await rig();
    made.server.reply('video-create', reply({ json: { task_id: 'task-3' } }));
    made.server.reply('video-query', reply({ json: { status: 'failed' } }));

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    const job = await waitForJob(made, started.id, finished);

    expect(job.state).toBe('failed');
    expect(job.error).toBe('The provider reported that video generation failed.');
    expect(labels(made)).not.toContain('download');
  });

  it('records a provider cancellation as cancelled, with no file', async () => {
    const made = await rig();
    made.server.reply('video-create', reply({ json: { task_id: 'task-4' } }));
    made.server.reply('video-query', reply({ json: { status: 'cancelled' } }));

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    const job = await waitForJob(made, started.id, finished);

    expect(job.state).toBe('cancelled');
    expect(job.filePath).toBeUndefined();
  });

  it('cancels a queued current-route video with a DELETE to the provider', async () => {
    const made = await rig();
    made.server.reply('video-create', reply({ json: { task_id: 'task-5' } }));
    made.server.reply('video-query', reply({ json: { status: 'queued' } }));
    made.server.reply('video-cancel', reply({ json: { base_resp: { status_code: 0 } } }));

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    await waitForJob(
      made,
      started.id,
      (job) => job.state === 'queued' && job.providerTaskId !== undefined,
    );
    const cancelled = await made.manager.cancel(started.id);

    expect(cancelled?.state).toBe('cancelled');
    const cancelCall = made.server.requests.find((request) => request.label === 'video-cancel');
    expect(cancelCall).toMatchObject({
      method: 'DELETE',
      path: '/v2/video_generation/task-5',
      authorizationOk: true,
    });
  });

  it('abandons a current-route video locally when the provider refuses the cancel', async () => {
    const made = await rig();
    made.server.reply('video-create', reply({ json: { task_id: 'task-14' } }));
    made.server.reply('video-query', reply({ json: { status: 'queued' } }));
    made.server.reply('video-cancel', reply({ status: 500, json: {} }));

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    await waitForJob(
      made,
      started.id,
      (job) => job.state === 'queued' && job.providerTaskId !== undefined,
    );
    const cancelled = await made.manager.cancel(started.id);

    expect(cancelled).toMatchObject({
      state: 'abandoned-locally',
      error: 'The local job was abandoned. Provider work may continue.',
    });
    expect(made.manager.status(started.id)?.state).toBe('abandoned-locally');
    expect(made.server.requests.find((request) => request.label === 'video-cancel')).toMatchObject({
      method: 'DELETE',
      path: '/v2/video_generation/task-14',
      authorizationOk: true,
    });
    expect(made.server.pending('video-cancel')).toBe(0);
  });

  it('abandons a legacy video locally and sends no cancel, because the legacy route has none', async () => {
    const made = await rig();
    made.server.reply('video-create', reply({ status: 404, json: {} }));
    made.server.reply('video-create-legacy', reply({ json: { task_id: 'legacy-2' } }));
    made.server.reply('video-query-legacy', reply({ json: { status: 'queued' } }));

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    await waitForJob(made, started.id, (job) => job.providerTaskId !== undefined);
    const cancelled = await made.manager.cancel(started.id);

    expect(cancelled?.state).toBe('abandoned-locally');
    expect(labels(made)).not.toContain('video-cancel');
  });

  it('fails a video after three status checks in a row fail, and keeps it alive after one', async () => {
    const made = await rig();
    made.server.reply('video-create', reply({ json: { task_id: 'task-6' } }));
    made.server.reply(
      'video-query',
      reply({ status: 500, json: {} }),
      reply({ json: { status: 'failed' } }),
    );

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    const job = await waitForJob(made, started.id, finished);

    // One failed check did not end the job: the next check read the provider's own failure.
    expect(job.error).toBe('The provider reported that video generation failed.');
    expect(labels(made).filter((label) => label === 'video-query')).toHaveLength(2);
  });

  it('fails a video whose status checks keep failing, after the limit of three', async () => {
    const made = await rig();
    made.server.reply('video-create', reply({ json: { task_id: 'task-7' } }));
    made.server.reply(
      'video-query',
      reply({ status: 500, json: {} }),
      reply({ status: 500, json: {} }),
      reply({ status: 500, json: {} }),
    );

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    const job = await waitForJob(made, started.id, finished);

    expect(job.state).toBe('failed');
    expect(job.error).toBe('The provider returned HTTP 500.');
    expect(labels(made).filter((label) => label === 'video-query')).toHaveLength(3);
  });

  it('times out a video that stays running past its limit', async () => {
    const made = await rig({ videoTimeoutMs: 80 });
    made.server.reply('video-create', reply({ json: { task_id: 'task-8' } }));
    made.server.reply('video-query', reply({ json: { status: 'running' } }));

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    const job = await waitForJob(made, started.id, finished);

    expect(job.state).toBe('timed-out');
    expect(job.error).toBe('The video task exceeded the 15-minute limit.');
  });

  it('refuses a second video while one is still active', async () => {
    const made = await rig();
    made.server.reply('video-create', reply({ json: { task_id: 'task-9' } }));
    made.server.reply('video-query', reply({ json: { status: 'queued' } }));

    made.server.reply('video-cancel', reply({ json: { base_resp: { status_code: 0 } } }));

    const first = await made.manager.start({ profileId: PROFILE.id, kind: 'video', prompt: 'one' });
    await waitForJob(made, first.id, (job) => job.providerTaskId !== undefined);

    await expect(
      made.manager.start({ profileId: PROFILE.id, kind: 'video', prompt: 'two' }),
    ).rejects.toThrow('Wait for the running picture or video to finish first.');
    expect((await made.manager.cancel(first.id))?.state).toBe('cancelled');
  });

  it('refuses an expired download link: the job fails and no file is kept', async () => {
    const made = await rig();
    made.server.reply('video-create', reply({ json: { task_id: 'task-10' } }));
    made.server.reply('video-query', reply({ json: { status: 'succeeded', file_id: 'file-3' } }));
    made.server.reply('download', reply({ status: 403, json: { error: 'link expired' } }));

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    const job = await waitForJob(made, started.id, finished);

    expect(job.state).toBe('failed');
    expect(job.error).toBe('The video download could not be read.');
    expect(readdirSync(made.generatedDirectory)).toEqual([]);
  });

  it('stops a video download the connection drops in the middle of, and keeps no partial file', async () => {
    const made = await rig();
    made.server.reply('video-create', reply({ json: { task_id: 'task-11' } }));
    made.server.reply('video-query', reply({ json: { status: 'succeeded', file_id: 'file-4' } }));
    made.server.reply(
      'download',
      reply({ body: VIDEO_BYTES, contentLength: VIDEO_BYTES.byteLength, dropAfterBytes: 900 }),
    );

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    const job = await waitForJob(made, started.id, finished);

    expect(job.state).toBe('failed');
    expect(job.filePath).toBeUndefined();
    expect(readdirSync(made.generatedDirectory)).toEqual([]);
  });

  it('refuses a video file larger than the limit before any of it is saved', async () => {
    const made = await rig({ maxVideoBytes: 1000 });
    made.server.reply('video-create', reply({ json: { task_id: 'task-12' } }));
    made.server.reply('video-query', reply({ json: { status: 'succeeded', file_id: 'file-5' } }));
    made.server.reply('download', reply({ body: VIDEO_BYTES }));

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    const job = await waitForJob(made, started.id, finished);

    expect(job.state).toBe('failed');
    expect(job.error).toContain('larger than the 1000-byte limit');
    expect(readdirSync(made.generatedDirectory)).toEqual([]);
  });

  it('refuses a download address that is not HTTPS or is on this computer (the real downloader)', async () => {
    const made = await rig();
    made.server.reply('download', reply({ body: VIDEO_BYTES }));
    const downloader = createPinnedGenerationDownloader();
    const controller = new AbortController();

    // The loopback fake is plain HTTP, so the protocol check refuses it before any connection is made.
    await expect(
      downloader(`${made.server.origin}/download/file.mp4`, controller.signal),
    ).rejects.toThrow(/^The video download address was refused\.$/);
    // This address passes the protocol check, so the refusal must come from the private-host check. The exact-message
    // regex fails the test if the request is attempted instead (port 443 here, not the fake).
    expect(isPrivateOrInternalHost('127.0.0.1')).toBe(true);
    await expect(
      downloader('https://127.0.0.1/download/file.mp4', controller.signal),
    ).rejects.toThrow(/^The video download address was refused\.$/);
    expect(labels(made)).toEqual([]);
  });
});

describe('generation against the fake MiniMax server: restarts', () => {
  it('resumes a video that was queued when the app stopped, and saves its file', async () => {
    // The first run never polls: its first poll is a minute away and stop() clears it. Every status read comes after
    // the restart, so the polling that finishes the job is the restarted manager's.
    const made = await rig({ pollIntervalMs: 60_000 });
    made.server.reply('video-create', reply({ json: { task_id: 'task-30' } }));
    made.server.reply(
      'video-query',
      reply({ json: { status: 'running' } }),
      reply({ json: { status: 'succeeded', file_id: 'file-30' } }),
    );
    made.server.reply('download', reply({ body: VIDEO_BYTES }));

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    made.manager.stop();
    expect(labels(made)).toEqual(['video-create']);

    const restarted = made.restart({ pollIntervalMs: 5 });
    restarted.resume();
    const job = await waitForJob(made, started.id, finished, restarted);

    expect(job).toMatchObject({
      state: 'completed',
      kind: 'video',
      route: 'current',
      providerTaskId: 'task-30',
    });
    expect(readFileSync(job.filePath ?? '').equals(VIDEO_BYTES)).toBe(true);
    expect(labels(made)).toEqual([
      'video-create',
      'video-query',
      'video-query',
      'file-link',
      'download',
    ]);
  });

  it('times out an overdue video on resume, without asking the provider', async () => {
    const made = await rig({ pollIntervalMs: 60_000, videoTimeoutMs: 15 * 60 * 1000 });
    made.server.reply('video-create', reply({ json: { task_id: 'task-31' } }));

    const started = await made.manager.start({
      profileId: PROFILE.id,
      kind: 'video',
      prompt: 'a slow pan',
    });
    made.manager.stop();

    // The restart happens sixteen minutes after the job was created, past the fifteen-minute limit.
    const restarted = made.restart({ now: () => Date.now() + 16 * 60 * 1000 });
    restarted.resume();

    expect(restarted.status(started.id)).toMatchObject({
      state: 'timed-out',
      error: 'The video task exceeded the 15-minute limit.',
    });
    expect(labels(made)).toEqual(['video-create']);
  });
});

describe('generation against the fake MiniMax server: secrets and state', () => {
  it('sends the key only as a bearer header and keeps it out of every job record and error', async () => {
    const made = await rig();
    made.server.reply('image', reply({ status: 401, json: { echo: KEY } }));
    made.server.reply('video-create', reply({ json: { task_id: 'task-20' } }));
    made.server.reply('video-query', reply({ json: { status: 'failed' } }));

    const picture = await made.manager.start({ profileId: PROFILE.id, kind: 'image', prompt: 'p' });
    await waitForJob(made, picture.id, finished);
    const video = await made.manager.start({ profileId: PROFILE.id, kind: 'video', prompt: 'v' });
    await waitForJob(made, video.id, finished);

    expect(made.server.requests.length).toBeGreaterThan(0);
    expect(made.server.requests.every((request) => request.authorizationOk)).toBe(true);
    expect(JSON.stringify(made.manager.list())).not.toContain(KEY);
    expect(JSON.stringify(made.server.requests.map((request) => request.body))).not.toContain(KEY);
  });
});
