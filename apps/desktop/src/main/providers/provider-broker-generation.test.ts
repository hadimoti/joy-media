import { describe, expect, it } from 'vitest';
import { createMemorySecretStore } from '@joy-media/provider-sdk';
import {
  createProviderBroker,
  endpointBindingDigest,
  type BrokerProfile,
  type ProviderFetch,
} from './provider-broker.js';

const NOW = Date.UTC(2026, 10, 13);
const KEY = 'not-a-real-key-for-tests';
// A 1x1 PNG. The documented reply shapes carry it as base64; it is not a recorded live reply.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

interface Scripted {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
}

/** A fetch that answers each call in turn from the script, and records what it was asked. */
function scripted(replies: readonly Scripted[]): {
  readonly fetch: ProviderFetch;
  readonly calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetch: ProviderFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      authorization: new Headers(init.headers).get('authorization'),
    });
    const next = replies[calls.length - 1];
    if (next === undefined) throw new Error('unscripted call');
    const text = next.body === undefined ? '' : JSON.stringify(next.body);
    return new Response(text, {
      status: next.status,
      headers: { 'content-type': 'application/json', ...next.headers },
    });
  };
  return { fetch, calls };
}

async function harness(provider: string, baseUrl: string, fetch: ProviderFetch) {
  const url = new URL(baseUrl);
  const profile: BrokerProfile = {
    id: 'profile-1',
    provider,
    baseUrl,
    modelId: 'model-1',
    secretHandleId: 'handle-1',
    bindingDigest: endpointBindingDigest('profile-1', url.origin, url.pathname),
    bindingSecretDigest: 'version-1',
  };
  const secrets = createMemorySecretStore();
  await secrets.set(profile.secretHandleId, KEY);
  return createProviderBroker({
    store: {
      getProfile: (id) => (id === profile.id ? profile : undefined),
      isDisabledLegacy: () => false,
      markCredentialUnavailable: () => undefined,
      secretVersion: () => 'version-1',
    },
    secrets,
    fetch,
    resolveHost: async () => [],
    now: () => NOW,
  });
}

const MINIMAX = 'https://api.minimax.io/v1';

describe('provider broker: generation refusals', () => {
  it('refuses a picture from the ChatGPT sign-in before any token or request is used', async () => {
    const { fetch, calls } = scripted([]);
    const broker = await harness('chatgpt', 'https://api.openai.com/v1', fetch);

    const result = await broker.generateImage({ profileId: 'profile-1', prompt: 'a cat' });

    expect(result).toMatchObject({ ok: false, code: 'GENERATION_NOT_SUPPORTED' });
    expect(JSON.stringify(result)).toContain('The ChatGPT sign-in cannot make pictures');
    expect(calls).toHaveLength(0);
  });

  it('refuses a video from an API-key provider that has no video route, with the reason', async () => {
    const { fetch, calls } = scripted([]);
    const broker = await harness('openai', 'https://api.openai.com/v1', fetch);

    const result = await broker.startVideo({ profileId: 'profile-1', prompt: 'a cat' });

    expect(result).toMatchObject({
      ok: false,
      code: 'GENERATION_NOT_SUPPORTED',
      message: 'OpenAI cannot make videos in JOY Media. Only MiniMax can.',
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses an empty prompt before any request is sent', async () => {
    const { fetch, calls } = scripted([]);
    const broker = await harness('minimax', MINIMAX, fetch);

    const result = await broker.generateImage({ profileId: 'profile-1', prompt: '   ' });

    expect(result).toMatchObject({ ok: false, code: 'GENERATION_BAD_PROMPT' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a task id that is not safe in a URL path, before any request is sent', async () => {
    const { fetch, calls } = scripted([]);
    const broker = await harness('minimax', MINIMAX, fetch);

    const result = await broker.videoStatus({
      profileId: 'profile-1',
      taskId: '../admin',
      route: 'current',
    });

    expect(result).toMatchObject({ ok: false, code: 'REQUEST_INVALID' });
    expect(calls).toHaveLength(0);
  });
});

describe('provider broker: MiniMax pictures', () => {
  it('accepts an image reply above the general response cap but within the generation cap', async () => {
    const image = Buffer.alloc(5 * 1024 * 1024);
    image.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { fetch } = scripted([
      { status: 200, body: { data: [{ b64_json: image.toString('base64') }] } },
    ]);
    const broker = await harness('minimax', MINIMAX, fetch);

    const result = await broker.generateImage({ profileId: 'profile-1', prompt: 'a red square' });

    expect(result).toMatchObject({ ok: true, data: { mimeType: 'image/png' } });
  });

  it('returns a checked base64 picture from the current route, with the bearer key sent once', async () => {
    const { fetch, calls } = scripted([
      { status: 200, body: { data: [{ b64_json: PNG_BASE64 }] } },
    ]);
    const broker = await harness('minimax', MINIMAX, fetch);

    const result = await broker.generateImage({ profileId: 'profile-1', prompt: 'a red square' });

    expect(result).toEqual({
      ok: true,
      data: {
        base64: PNG_BASE64,
        mimeType: 'image/png',
        model: 'MiniMax-H3-Image',
        route: 'current',
      },
    });
    expect(calls).toEqual([
      {
        url: 'https://api.minimax.io/v1/images/generations',
        method: 'POST',
        authorization: `Bearer ${KEY}`,
      },
    ]);
  });

  it('falls back to the legacy route only when the current route is missing', async () => {
    const { fetch, calls } = scripted([
      { status: 404, body: { error: 'not found' } },
      { status: 200, body: { data: { image_base64: [PNG_BASE64] } } },
    ]);
    const broker = await harness('minimax', MINIMAX, fetch);

    const result = await broker.generateImage({ profileId: 'profile-1', prompt: 'a red square' });

    expect(result).toMatchObject({ ok: true, data: { route: 'legacy', model: 'image-01' } });
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.minimax.io/v1/images/generations',
      'https://api.minimax.io/v1/image_generation',
    ]);
  });

  it('does not fall back on a refused key: the refusal is typed and nothing else is sent', async () => {
    const { fetch, calls } = scripted([{ status: 401, body: {} }]);
    const broker = await harness('minimax', MINIMAX, fetch);

    const result = await broker.generateImage({ profileId: 'profile-1', prompt: 'a red square' });

    expect(result).toMatchObject({ ok: false, code: 'AUTH_FAILED' });
    expect(calls).toHaveLength(1);
  });

  it('maps a key whose plan does not allow the model to NOT_ALLOWED', async () => {
    const { fetch } = scripted([{ status: 403, body: {} }]);
    const broker = await harness('minimax', MINIMAX, fetch);

    const result = await broker.generateImage({ profileId: 'profile-1', prompt: 'a red square' });

    expect(result).toMatchObject({ ok: false, code: 'GENERATION_NOT_ALLOWED' });
  });

  it('maps a balance error sent with a 200 to QUOTA', async () => {
    const { fetch } = scripted([
      {
        status: 200,
        body: { base_resp: { status_code: 1008, status_msg: 'insufficient balance' } },
      },
    ]);
    const broker = await harness('minimax', MINIMAX, fetch);

    const result = await broker.generateImage({ profileId: 'profile-1', prompt: 'a red square' });

    expect(result).toMatchObject({ ok: false, code: 'GENERATION_QUOTA' });
  });

  it('refuses a reply that carries the key, and returns no picture', async () => {
    const { fetch } = scripted([
      {
        status: 200,
        body: {
          data: [{ b64_json: PNG_BASE64 }],
          base_resp: { status_code: 0, status_msg: `echoed ${KEY}` },
        },
      },
    ]);
    const broker = await harness('minimax', MINIMAX, fetch);

    const result = await broker.generateImage({ profileId: 'profile-1', prompt: 'a red square' });

    expect(result).toMatchObject({ ok: false, code: 'PROVIDER_INCOMPATIBLE' });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain(PNG_BASE64);
  });

  it('refuses a redirect and never follows it', async () => {
    const { fetch, calls } = scripted([
      { status: 302, headers: { location: 'https://elsewhere.example.test/x' } },
    ]);
    const broker = await harness('minimax', MINIMAX, fetch);

    const result = await broker.generateImage({ profileId: 'profile-1', prompt: 'a red square' });

    expect(result).toMatchObject({ ok: false, code: 'REDIRECT_REFUSED' });
    expect(calls).toHaveLength(1);
  });
});

describe('provider broker: MiniMax video jobs', () => {
  it('starts a task on the current route and reads its status and cancels it', async () => {
    const { fetch, calls } = scripted([
      { status: 200, body: { task_id: 'task-1' } },
      { status: 200, body: { status: 'running' } },
      { status: 200, body: { base_resp: { status_code: 0 } } },
    ]);
    const broker = await harness('minimax', MINIMAX, fetch);

    const started = await broker.startVideo({ profileId: 'profile-1', prompt: 'a slow pan' });
    expect(started).toEqual({ ok: true, data: { taskId: 'task-1', route: 'current' } });
    if (!started.ok) return;

    const status = await broker.videoStatus({
      profileId: 'profile-1',
      taskId: started.data.taskId,
      route: started.data.route,
    });
    expect(status).toEqual({ ok: true, data: { status: 'running' } });

    const cancelled = await broker.cancelVideo({
      profileId: 'profile-1',
      taskId: started.data.taskId,
      route: started.data.route,
    });
    expect(cancelled).toEqual({ ok: true, data: { cancelled: true } });

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', 'https://api.minimax.io/v2/video_generation'],
      ['GET', 'https://api.minimax.io/v2/query/video_generation/task-1'],
      ['DELETE', 'https://api.minimax.io/v2/video_generation/task-1'],
    ]);
  });

  it('starts on the legacy route when the current one is missing, and sends no cancel for it', async () => {
    const { fetch, calls } = scripted([
      { status: 404, body: {} },
      { status: 200, body: { task_id: 'legacy-1' } },
    ]);
    const broker = await harness('minimax', MINIMAX, fetch);

    const started = await broker.startVideo({ profileId: 'profile-1', prompt: 'a slow pan' });
    expect(started).toEqual({ ok: true, data: { taskId: 'legacy-1', route: 'legacy' } });

    const cancelled = await broker.cancelVideo({
      profileId: 'profile-1',
      taskId: 'legacy-1',
      route: 'legacy',
    });
    expect(cancelled).toEqual({
      ok: true,
      data: {
        cancelled: false,
        message: 'The legacy route has no cancel call. Let the task finish.',
      },
    });
    expect(calls).toHaveLength(2);
  });

  it('returns the download link of a finished file, and refuses an unsafe file id', async () => {
    const { fetch, calls } = scripted([
      { status: 200, body: { file: { download_url: 'https://files.example.test/v.mp4' } } },
    ]);
    const broker = await harness('minimax', MINIMAX, fetch);

    const unsafe = await broker.videoFileLink({ profileId: 'profile-1', fileId: 'x?y=1' });
    expect(unsafe).toMatchObject({ ok: false, code: 'REQUEST_INVALID' });
    expect(calls).toHaveLength(0);

    const link = await broker.videoFileLink({ profileId: 'profile-1', fileId: 'file-9' });
    expect(link).toEqual({ ok: true, data: { downloadUrl: 'https://files.example.test/v.mp4' } });
    expect(calls[0]?.url).toBe('https://api.minimax.io/v1/files/retrieve?file_id=file-9');
  });
});
