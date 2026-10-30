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

const ORIGIN = 'joy-media-app://renderer';
const CHATGPT_SECRET = 'signed-in-secret-value';
function harness(
  providerSignIn?: (
    provider: SignInProvider,
    context?: ProviderSignInContext,
  ) => Promise<SignInResult>,
) {
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
      provider: 'chatgpt',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-6.1-sol',
      secret: CHATGPT_SECRET,
    }));
    const { handlers, localDatabase, secretStore } = harness(providerSignIn);

    const result = await dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in',
      payload: { provider: 'chatgpt' },
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(CHATGPT_SECRET);
    expect(providerSignIn).toHaveBeenCalledWith('chatgpt');
    const [profile] = localDatabase.listProviderProfiles();
    expect(profile).toMatchObject({
      provider: 'chatgpt',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-6.1-sol',
    });
    expect(await secretStore.get(profile?.secretHandleId ?? '')).toBe(CHATGPT_SECRET);
  });

  it('forwards the selected MiniMax region to the main-process sign-in flow', async () => {
    const providerSignIn = vi.fn(async (): Promise<SignInResult> => ({
      provider: 'minimax',
      baseUrl: 'https://api.minimax.io/v1',
      modelId: 'MiniMax-M2',
      secret: 'minimax-secret',
    }));
    const { handlers } = harness(providerSignIn);

    const result = await dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in',
      payload: { provider: 'minimax', region: 'cn' },
    });

    expect(result.ok).toBe(true);
    expect(providerSignIn).toHaveBeenCalledWith('minimax', { minimaxRegion: 'cn' });
  });

  it('defaults a MiniMax sign-in with no region to Global', async () => {
    const providerSignIn = vi.fn(async (): Promise<SignInResult> => ({
      provider: 'minimax',
      baseUrl: 'https://api.minimax.io/v1',
      modelId: 'MiniMax-M2',
      secret: 'minimax-secret',
    }));
    const { handlers } = harness(providerSignIn);

    const result = await dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in',
      payload: { provider: 'minimax' },
    });

    expect(result.ok).toBe(true);
    expect(providerSignIn).toHaveBeenCalledWith('minimax', { minimaxRegion: 'global' });
  });

  it.each(['us', 1, null])(
    'rejects unsupported MiniMax region %j before sign-in or profile writes',
    async (region) => {
      const providerSignIn = vi.fn();
      const { handlers, localDatabase } = harness(providerSignIn);

      const result = await dispatchIpcRequest(handlers, {
        origin: ORIGIN,
        channel: 'desktop.provider-profile.sign-in',
        payload: { provider: 'minimax', region },
      });

      expect(result).toMatchObject({ ok: false, error: 'Invalid sign-in request' });
      expect(providerSignIn).not.toHaveBeenCalled();
      expect(localDatabase.listProviderProfiles()).toHaveLength(0);
    },
  );

  it('rejects a region on non-MiniMax sign-in requests before sign-in starts', async () => {
    const providerSignIn = vi.fn();
    const { handlers, localDatabase } = harness(providerSignIn);

    const result = await dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in',
      payload: { provider: 'chatgpt', region: 'global' },
    });

    expect(result).toMatchObject({ ok: false, error: 'Invalid sign-in request' });
    expect(providerSignIn).not.toHaveBeenCalled();
    expect(localDatabase.listProviderProfiles()).toHaveLength(0);
  });

  it('refuses a provider that is set up with an API key, such as OpenRouter, before any sign-in starts', async () => {
    const providerSignIn = vi.fn();
    const { handlers, localDatabase } = harness(providerSignIn);
    const result = await dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in',
      payload: { provider: 'openrouter' },
    });
    expect(result).toMatchObject({ ok: false, error: 'Invalid sign-in request' });
    expect(providerSignIn).not.toHaveBeenCalled();
    expect(localDatabase.listProviderProfiles()).toHaveLength(0);
  });

  it('refuses a sign-in result that names another provider, and saves nothing', async () => {
    const providerSignIn = vi.fn(async (): Promise<SignInResult> => ({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openrouter/auto',
      secret: CHATGPT_SECRET,
    }));
    const { handlers, localDatabase } = harness(providerSignIn);
    const result = await dispatchIpcRequest(handlers, {
      origin: ORIGIN,
      channel: 'desktop.provider-profile.sign-in',
      payload: { provider: 'chatgpt' },
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'The sign-in did not return a provider that can be signed in to',
    });
    expect(localDatabase.listProviderProfiles()).toHaveLength(0);
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
      payload: { provider: 'chatgpt', id: 'missing-profile' },
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
      payload: { provider: 'chatgpt' },
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'Sign-in is not available in this build',
    });
  });
});
