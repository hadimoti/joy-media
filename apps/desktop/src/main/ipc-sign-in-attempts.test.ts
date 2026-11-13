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
  ) => Promise<SignInResult>,
  signInAttempts?: {
    cancel: (provider: string) => boolean;
    reopen: (provider: string) => Promise<boolean>;
  },
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
    secretStore: createMemorySecretStore(),
    providerBroker,
    providerSignIn,
    ...(signInAttempts === undefined ? {} : { signInAttempts }),
    now: () => 'T0',
    newId: () => `id-${++idCount}`,
  });
}

/** A sign-in that waits until its attempt is cancelled, as the real flow waits for its callback. */
function waitingSignIn(attempts: ReturnType<typeof createSignInAttempts>) {
  const runs: SignInAttemptContext[] = [];
  const signIn = vi.fn((provider: SignInProvider) =>
    attempts.start(provider, (ctx) => {
      runs.push(ctx);
      return new Promise<SignInResult>((_resolve, reject) => {
        ctx.signal.addEventListener(
          'abort',
          () => reject(new OAuthFlowError('CANCELLED', 'The sign-in was cancelled.')),
          { once: true },
        );
      });
    }),
  );
  return { signIn, runs };
}

function registry() {
  return createSignInAttempts({
    now: () => 0,
    waitMs: 5 * 60_000,
    openExternal: vi.fn(),
  });
}

describe('cancel and reopen through IPC (T-J03)', () => {
  it('cancels a running sign-in: the sign-in fails as cancelled and the cancel reports it', async () => {
    const attempts = registry();
    const { signIn } = waitingSignIn(attempts);
    const handlers = harness(signIn, {
      cancel: (provider) => attempts.cancel(provider),
      reopen: (provider) => attempts.reopen(provider),
    });

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
    const { signIn } = waitingSignIn(attempts);
    const handlers = harness(signIn, {
      cancel: (provider) => attempts.cancel(provider),
      reopen: (provider) => attempts.reopen(provider),
    });

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
    const handlers = harness(vi.fn(), {
      cancel: (provider) => attempts.cancel(provider),
      reopen: (provider) => attempts.reopen(provider),
    });
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
    const handlers = harness(vi.fn(), {
      cancel: (provider) => attempts.cancel(provider),
      reopen: (provider) => attempts.reopen(provider),
    });
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
});
