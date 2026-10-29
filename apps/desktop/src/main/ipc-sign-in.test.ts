import { describe, expect, it, vi } from 'vitest';
import { createMemorySecretStore } from '@joy-media/provider-sdk';
import { createIpcHandlers, dispatchIpcRequest } from './ipc-handlers.js';
import { createFileRegistry } from './file-registry.js';
import { createWorkerSupervisor } from './worker-supervisor.js';
import type { SupervisedChild } from './worker-supervisor.js';
import { LocalDatabase } from '../store/local-database.js';
import type { ProviderBroker } from './providers/provider-broker.js';
import { OAuthFlowError } from './oauth/errors.js';
import type { SignInProvider, SignInResult } from './oauth/sign-in.js';

const ORIGIN = 'joy-media-app://renderer';
const OPENROUTER_SECRET = 'sk-or-v1-secret-value';

function harness(providerSignIn?: (provider: SignInProvider) => Promise<SignInResult>) {
  const localDatabase = new LocalDatabase({
    filePath: ':memory:',
    idFactory: () => 'job-1',
    now: () => 'T0',
  });
  const secretStore = createMemorySecretStore();
  // The broker is not reached by a sign-in, so a stub stands in for it.
  const providerBroker = {
    complete: vi.fn(),
    probe: vi.fn(),
    listModels: vi.fn(),
  } as unknown as ProviderBroker;
  let idCount = 0;
  const handlers = createIpcHandlers({
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
    providerBroker,
    ...(providerSignIn === undefined ? {} : { providerSignIn }),
    now: () => 'T0',
    newId: () => `id-${++idCount}`,
  });
  return { handlers, localDatabase, secretStore };
}

describe('desktop.provider-profile.sign-in', () => {
  it('saves the signed-in profile through the save route, and never returns its secret', async () => {
    const providerSignIn = vi.fn(async (): Promise<SignInResult> => ({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openrouter/auto',
      secret: OPENROUTER_SECRET,
    }));
    const { handlers, localDatabase, secretStore } = harness(providerSignIn);

    const result = await dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in',
      payload: { provider: 'openrouter' },
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(OPENROUTER_SECRET);
    expect(providerSignIn).toHaveBeenCalledWith('openrouter');
    const [profile] = localDatabase.listProviderProfiles();
    expect(profile).toMatchObject({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openrouter/auto',
    });
    expect(await secretStore.get(profile?.secretHandleId ?? '')).toBe(OPENROUTER_SECRET);
  });

  it('refuses a request that names no provider it can sign in to, before any sign-in starts', async () => {
    const providerSignIn = vi.fn();
    const { handlers } = harness(providerSignIn);
    const result = await dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in',
      payload: { provider: 'grok' },
    });
    expect(result).toMatchObject({ ok: false, error: 'Invalid sign-in request' });
    expect(providerSignIn).not.toHaveBeenCalled();
  });

  it('refuses to sign a profile in again when it is not a profile of that provider', async () => {
    const providerSignIn = vi.fn();
    const { handlers } = harness(providerSignIn);
    const result = await dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in',
      payload: { provider: 'openrouter', id: 'missing-profile' },
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'That profile cannot be signed in again',
    });
    expect(providerSignIn).not.toHaveBeenCalled();
  });

  it('shows a sign-in failure as its own message, and saves nothing', async () => {
    const { handlers, localDatabase } = harness(async () => {
      throw new OAuthFlowError(
        'NOT_CONFIGURED',
        'ChatGPT sign-in is not configured in this build yet.',
      );
    });
    const result = await dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in',
      payload: { provider: 'chatgpt' },
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'ChatGPT sign-in is not configured in this build yet.',
    });
    expect(localDatabase.listProviderProfiles()).toHaveLength(0);
  });

  it('refuses when no sign-in runner is wired into this build', async () => {
    const { handlers } = harness();
    const result = await dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in',
      payload: { provider: 'openrouter' },
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'Sign-in is not available in this build',
    });
  });
});
