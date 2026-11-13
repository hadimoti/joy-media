import { describe, expect, it, vi } from 'vitest';
import { createMemorySecretStore } from '@joy-media/provider-sdk';
import { createIpcHandlers, dispatchIpcRequest } from './ipc-handlers.js';
import { createFileRegistry } from './file-registry.js';
import { createWorkerSupervisor } from './worker-supervisor.js';
import type { SupervisedChild } from './worker-supervisor.js';
import { LocalDatabase } from '../store/local-database.js';
import type { ProviderBroker } from './providers/provider-broker.js';
import { OAuthFlowError } from './oauth/errors.js';
import type { ProviderSignInContext, SignInProvider, SignInResult } from './oauth/sign-in.js';
import { createProviderSignIn } from './oauth/sign-in.js';
import { KIMI_CODE_BASE_URL } from './oauth/kimi.js';
import type { FetchLike } from './oauth/http.js';
import { createSignInAttempts, type SignInAttemptContext } from './oauth/sign-in-attempts.js';

/**
 * T-J03: the cancel and reopen channels reach the attempt registry. A stub sign-in runs under the real
 * registry; it waits for its signal, like the real flow waits for its listener. No provider is contacted.
 */

const ORIGIN = 'joy-media-app://renderer';

function harness(
  providerSignIn: (
    provider: SignInProvider,
    context?: ProviderSignInContext,
    call?: {
      readonly signal?: AbortSignal;
      readonly openExternal?: (url: string) => void | Promise<void>;
    },
  ) => Promise<SignInResult>,
  signInAttempts?: ReturnType<typeof createSignInAttempts>,
  secretStore = createMemorySecretStore(),
  openExternal: (url: string) => void | Promise<void> = vi.fn(),
) {
  const localDatabase = new LocalDatabase({
    filePath: ':memory:',
    idFactory: () => 'job-1',
    now: () => 'T0',
  });
  const providerBroker = {
    complete: vi.fn(),
    probe: vi.fn(),
    listModels: vi.fn(),
  } as unknown as ProviderBroker;
  let idCount = 0;
  return createIpcHandlers({
    fileRegistry: createFileRegistry(() => 'ref-1'),
    workerSupervisor: createWorkerSupervisor({
      spawn: (): SupervisedChild => ({ once: () => {}, kill: () => true }),
      command: 'node',
      workerId: () => 'w-1',
    }),
    showOpenDialog: vi.fn(async () => ({ canceled: true, path: undefined })),
    localDatabase,
    probeMedia: vi.fn(async () => ({ checksum: 'sha', byteSize: 1, kind: 'video' as const })),
    secretStore,
    openExternal,
    providerBroker,
    providerSignIn,
    ...(signInAttempts === undefined ? {} : { signInAttempts }),
    now: () => 'T0',
    newId: () => `id-${++idCount}`,
  });
}

/** A sign-in that waits until its attempt is cancelled, as a provider flow waits for its callback. */
function waitingSignIn() {
  const runs: SignInAttemptContext[] = [];
  const signIn = vi.fn(
    (
      _provider: SignInProvider,
      _context?: ProviderSignInContext,
      call?: { readonly signal?: AbortSignal },
    ) =>
      new Promise<SignInResult>((_resolve, reject) => {
        const context = { signal: call?.signal } as SignInAttemptContext;
        runs.push(context);
        call?.signal?.addEventListener(
          'abort',
          () => reject(new OAuthFlowError('CANCELLED', 'The sign-in was cancelled.')),
          { once: true },
        );
      }),
  );
  return { signIn, runs };
}

function registry() {
  return createSignInAttempts({
    now: () => 0,
    waitMs: 3 * 60_000,
    openExternal: vi.fn(),
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('cancel and reopen through IPC (T-J03)', () => {
  it('cancels a running sign-in: the sign-in fails as cancelled and the cancel reports it', async () => {
    const attempts = registry();
    const { signIn } = waitingSignIn();
    const handlers = harness(signIn, attempts);

    const pending = dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in',
      payload: { provider: 'chatgpt' },
    });
    await vi.waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));

    const cancelled = await dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in-cancel',
      payload: { provider: 'chatgpt' },
    });
    expect(cancelled).toMatchObject({ ok: true, data: { cancelled: true } });

    const finished = await pending;
    expect(finished).toMatchObject({ ok: false, error: 'The sign-in was cancelled.' });
  });

  it('a sign-in started again after a cancel reaches the runner a second time', async () => {
    const attempts = registry();
    const { signIn } = waitingSignIn();
    const handlers = harness(signIn, attempts);

    const first = dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in',
      payload: { provider: 'chatgpt' },
    });
    await vi.waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));

    const second = dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in',
      payload: { provider: 'chatgpt' },
    });
    await expect(first).resolves.toMatchObject({ ok: false });
    await vi.waitFor(() => expect(signIn).toHaveBeenCalledTimes(2));

    // Clean up the second attempt so the test ends with nothing running.
    await dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in-cancel',
      payload: { provider: 'chatgpt' },
    });
    await expect(second).resolves.toMatchObject({ ok: false });
  });

  it('cancel reports false when nothing is running', async () => {
    const attempts = registry();
    const handlers = harness(vi.fn(), attempts);
    await expect(
      dispatchIpcRequest(handlers, {
        origin: ORIGIN,
        channel: 'desktop.provider-profile.sign-in-cancel',
        payload: { provider: 'chatgpt' },
      }),
    ).resolves.toMatchObject({ ok: true, data: { cancelled: false } });
  });

  it('refuses a cancel or reopen for a provider that cannot sign in, and a missing provider', async () => {
    const attempts = registry();
    const handlers = harness(vi.fn(), attempts);
    for (const channel of [
      'desktop.provider-profile.sign-in-cancel',
      'desktop.provider-profile.sign-in-reopen',
    ] as const) {
      await expect(
        dispatchIpcRequest(handlers, {
          origin: ORIGIN,
          channel,
          payload: { provider: 'openrouter' },
        }),
      ).resolves.toMatchObject({ ok: false, error: 'Invalid sign-in request' });
      await expect(
        dispatchIpcRequest(handlers, { origin: ORIGIN, channel, payload: {} }),
      ).resolves.toMatchObject({ ok: false });
    }
  });

  it('refuses cancel and reopen when the build has no attempt registry', async () => {
    const handlers = harness(vi.fn());
    await expect(
      dispatchIpcRequest(handlers, {
        origin: ORIGIN,
        channel: 'desktop.provider-profile.sign-in-cancel',
        payload: { provider: 'chatgpt' },
      }),
    ).resolves.toMatchObject({ ok: false, error: 'Sign-in is not available in this build' });
  });

  it('does not save a profile or secret when cancelled after the provider returns and before save', async () => {
    const attempts = registry();
    const secretStore = createMemorySecretStore();
    const setSecret = vi.spyOn(secretStore, 'set');
    const signIn = vi.fn(async (provider: SignInProvider) => {
      attempts.cancel(provider);
      return {
        provider,
        baseUrl: 'https://api.openai.com/v1',
        modelId: 'gpt-test-model',
        secret: 'fake-credential-record',
      };
    });
    const handlers = harness(signIn, attempts, secretStore);

    const result = await dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in',
      payload: { provider: 'chatgpt' },
    });
    const profiles = await dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.list',
      payload: undefined,
    });

    expect(result).toMatchObject({ ok: false, error: 'The sign-in was cancelled.' });
    expect(setSecret).not.toHaveBeenCalled();
    expect(profiles).toMatchObject({ ok: true, data: [] });
  });

  it('passes IPC cancellation through Kimi model lookup and leaves storage empty', async () => {
    const attempts = registry();
    const secretStore = createMemorySecretStore();
    const setSecret = vi.spyOn(secretStore, 'set');
    let modelSignal: AbortSignal | undefined;
    let releaseModels: (response: Response) => void = () => undefined;
    const modelResponse = new Promise<Response>((resolve) => {
      releaseModels = resolve;
    });
    const fetch: FetchLike = async (url, init) => {
      if (url === 'https://auth.kimi.ai/api/oauth/device_authorization') {
        return jsonResponse({
          user_code: 'KIMI-USER-CODE',
          device_code: 'private-device-code',
          verification_uri_complete:
            'https://www.kimi.ai/code/authorize_device?user_code=KIMI-USER-CODE',
          expires_in: 120,
          interval: 1,
        });
      }
      if (url === 'https://auth.kimi.ai/api/oauth/token') {
        return jsonResponse({
          access_token: 'kimi-access-token',
          refresh_token: 'kimi-refresh-token',
          expires_in: 3600,
          scope: 'kimi-code',
        });
      }
      if (url === `${KIMI_CODE_BASE_URL}/models`) {
        modelSignal = init.signal ?? undefined;
        return modelResponse;
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const signIn = createProviderSignIn({
      openExternal: vi.fn(),
      fetch,
      now: () => Date.UTC(2026, 9, 30),
      chatGptClientId: undefined,
      installId: () => 'urn:uuid:550e8400-e29b-41d4-a716-446655440000',
    });
    const handlers = harness(signIn, attempts, secretStore);
    const pending = dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in',
      payload: { provider: 'kimi' },
    });
    await vi.waitFor(() => expect(modelSignal).toBeDefined());

    const cancelled = await dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in-cancel',
      payload: { provider: 'kimi' },
    });
    releaseModels(jsonResponse({ data: [{ id: 'kimi-code-model' }] }));

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: 'The sign-in was cancelled.',
    });
    expect(cancelled).toMatchObject({ ok: true, data: { cancelled: true } });
    expect(modelSignal?.aborted).toBe(true);
    expect(setSecret).not.toHaveBeenCalled();
    await expect(
      dispatchIpcRequest(handlers, {
        origin: ORIGIN,
        channel: 'desktop.provider-profile.list',
        payload: undefined,
      }),
    ).resolves.toMatchObject({ ok: true, data: [] });
  });
});
