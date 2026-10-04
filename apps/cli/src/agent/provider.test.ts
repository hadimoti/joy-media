import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_KILO_MODEL,
  KILO_GATEWAY_BASE_URL,
  DEFAULT_OPENROUTER_MODEL,
} from '@joy-media/joy-agent-engine';
import {
  resolveByokConfig,
  describeEffectiveConfig,
  retryProviderFetch,
  validateProviderBaseUrl,
} from './provider.js';
import * as providerModule from './provider.js';
import { runJoyAgent } from './joy-agent.js';
import { createDefaultProject } from '../utils/project-loader.js';
import { getCliConfigPath, saveJoySession } from '../utils/config.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureSecretStoreRuntimeForTests } from '../utils/secret-store.js';

let tempHome: string | undefined;

function isolateConfig(): void {
  tempHome = mkdtempSync(join(tmpdir(), 'joy-provider-test-'));
  vi.stubEnv('USERPROFILE', tempHome);
  vi.stubEnv('HOME', tempHome);
  for (const key of [
    'KILO_API_KEY',
    'OPENROUTER_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'JOY_MEDIA_SESSION_TOKEN',
  ]) {
    vi.stubEnv(key, '');
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
});

describe('effective BYOK provider configuration', () => {
  it('allows only HTTPS or loopback HTTP custom provider URLs', () => {
    for (const url of [
      'http://127.0.0.1:1234/v1',
      'http://localhost:1234/v1',
      'http://[::1]:1234/v1',
      'https://provider.example/v1',
    ])
      expect(() => validateProviderBaseUrl(url)).not.toThrow();
    expect(() => validateProviderBaseUrl('http://provider.example/v1')).toThrow(
      'INSECURE_PROVIDER_URL',
    );
  });
  it('resolves LM Studio to its local endpoint without requiring an API key', async () => {
    isolateConfig();
    const resolved = await resolveByokConfig({ provider: 'lm-studio' });
    expect(resolved).toMatchObject({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1234/v1',
      modelId: 'local-model',
    });
  });
  it('retries provider 429 responses after the advertised seconds delay', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '2' } }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      const pending = retryProviderFetch(
        'https://provider.example/v1/chat/completions',
        {},
        fetchImpl,
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toMatchObject({ status: 200 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors HTTP-date Retry-After and gives up after three attempts', async () => {
    vi.useFakeTimers();
    try {
      const retryAt = new Date(Date.now() + 1_000).toUTCString();
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, { status: 429, headers: { 'retry-after': retryAt } }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '0' } }))
        .mockResolvedValueOnce(new Response(null, { status: 429 }));
      const pending = retryProviderFetch(
        'https://provider.example/v1/chat/completions',
        {},
        fetchImpl,
        'openrouter',
      );
      const rejected = expect(pending).rejects.toThrow(
        /JOY_AGENT_RATE_LIMITED: openrouter after 3 attempts; last Retry-After: not provided/,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    { name: 'no provider key', env: {}, provider: 'openrouter', source: 'default' },
    {
      name: 'Kilo key',
      env: { KILO_API_KEY: 'sk-test-REDACTED-0000' },
      provider: 'kilo',
      source: 'env',
    },
    {
      name: 'OpenRouter key',
      env: { OPENROUTER_API_KEY: 'sk-test-REDACTED-0000' },
      provider: 'openrouter',
      source: 'env',
    },
    {
      name: 'both keys',
      env: {
        KILO_API_KEY: 'sk-test-REDACTED-0000',
        OPENROUTER_API_KEY: 'sk-test-REDACTED-0000',
      },
      provider: 'kilo',
      source: 'env',
    },
  ])(
    'resolves $name consistently for display and provider creation',
    async ({ env, provider, source }) => {
      isolateConfig();
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const description = describeEffectiveConfig();
      expect(description).toMatchObject({ provider, source });
      if (Object.keys(env).length === 0) {
        await expect(resolveByokConfig()).rejects.toThrow(
          'No API key for openrouter: set OPENROUTER_API_KEY',
        );
      } else {
        const resolved = await resolveByokConfig();
        expect(description.modelId).toBe(resolved.modelId);
        expect(description.baseUrl).toBe(resolved.baseUrl);
        expect(resolved.modelId).toBe(
          provider === 'kilo' ? DEFAULT_KILO_MODEL : DEFAULT_OPENROUTER_MODEL,
        );
      }
    },
  );

  it('uses the BytePlus creative preset for a Kilo provider', async () => {
    isolateConfig();
    const resolved = await resolveByokConfig({ provider: 'kilo', apiKey: 'k' });
    expect(resolved).toMatchObject({
      baseUrl: KILO_GATEWAY_BASE_URL,
      modelId: DEFAULT_KILO_MODEL,
    });
  });

  it('does not call a provider when its API key is missing', async () => {
    isolateConfig();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const modelSpy = vi.spyOn(providerModule, 'createModelFromConfig');
    try {
      const error =
        'No API key for kilo: set KILO_API_KEY or run `joy-media agent provider add kilo --api-key-env KILO_API_KEY`';
      await expect(resolveByokConfig({ provider: 'kilo' })).rejects.toThrow(error);
      await expect(
        runJoyAgent({
          project: createDefaultProject('No key project'),
          revision: 0,
          prompt: 'Inspect the project',
          providerOptions: { provider: 'kilo' },
        }),
      ).rejects.toThrow(error);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(modelSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      modelSpy.mockRestore();
    }
  });

  it('migrates the legacy model default only to its saved provider', () => {
    isolateConfig();
    writeFileSync(
      getCliConfigPath(),
      JSON.stringify({ activeProvider: 'openrouter', defaultModel: 'openai/gpt-4o-mini' }),
    );
    expect(describeEffectiveConfig({ provider: 'kilo' }).modelId).toBe(DEFAULT_KILO_MODEL);
    expect(describeEffectiveConfig({ provider: 'openrouter' }).modelId).toBe('openai/gpt-4o-mini');
  });

  it('uses the Anthropic endpoint and model default', () => {
    isolateConfig();
    expect(describeEffectiveConfig({ provider: 'anthropic' })).toMatchObject({
      baseUrl: 'https://api.anthropic.com/v1/',
      modelId: 'claude-sonnet-4-5',
    });
  });

  it('requires explicit base URLs for unknown providers', () => {
    isolateConfig();
    expect(() => describeEffectiveConfig({ provider: 'foo' })).toThrow(
      'Provider "foo" needs --base-url',
    );
  });

  it('resolves JOY hosted from a stubbed default catalog and env token', async () => {
    isolateConfig();
    vi.stubEnv('JOY_MEDIA_SESSION_TOKEN', 'tok-fake-1');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [{ id: 'joy-model-test', isDefault: true, vision: true }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    try {
      const resolved = await resolveByokConfig({ provider: 'joy-hosted' });
      expect(resolved).toMatchObject({
        provider: 'joy-hosted',
        baseUrl: 'https://joyst.ir/api/v1/agent',
        modelId: 'joy-model-test',
        apiKey: 'tok-fake-1',
        vision: true,
      });
      await resolveByokConfig({ provider: 'joy-hosted' });
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('uses the saved login session for JOY hosted and sends it as a Bearer token', async () => {
    isolateConfig();
    const restoreSecretStore = configureSecretStoreRuntimeForTests({
      platform: 'linux',
      runner: () => ({ status: 0, stdout: '' }),
    });
    saveJoySession({ token: 'tok-fake-stored' }, true);
    restoreSecretStore();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ models: [{ id: 'joy-model-test', isDefault: true }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    try {
      const resolved = await resolveByokConfig({
        provider: 'joy-hosted',
        baseUrl: 'https://joy-hosted-stored-test.invalid/api/v1/agent',
      });
      expect(resolved.apiKey).toBe('tok-fake-stored');
      expect(fetchSpy.mock.calls[0]?.[1]?.headers).toEqual({
        Authorization: 'Bearer tok-fake-stored',
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('gives JOY_MEDIA_SESSION_TOKEN precedence over a saved session', async () => {
    isolateConfig();
    const restoreSecretStore = configureSecretStoreRuntimeForTests({
      platform: 'linux',
      runner: () => ({ status: 0, stdout: '' }),
    });
    saveJoySession({ token: 'tok-fake-stored' }, true);
    restoreSecretStore();
    vi.stubEnv('JOY_MEDIA_SESSION_TOKEN', 'tok-fake-env');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ models: [{ id: 'joy-model-test', isDefault: true }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    try {
      await expect(resolveByokConfig({ provider: 'joy-hosted' })).resolves.toMatchObject({
        apiKey: 'tok-fake-env',
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('uses the hosted catalog vision flag for an explicitly selected model', async () => {
    isolateConfig();
    vi.stubEnv('JOY_MEDIA_SESSION_TOKEN', 'tok-fake-1');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ models: [{ id: 'anthropic/claude-sonnet-4.6', vision: true }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    try {
      const resolved = await resolveByokConfig({
        provider: 'joy-hosted',
        model: 'anthropic/claude-sonnet-4.6',
        baseUrl: 'https://joy-hosted-vision-test.invalid/api/v1/agent',
      });
      expect(resolved).toMatchObject({ modelId: 'anthropic/claude-sonnet-4.6', vision: true });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('reports a clear missing JOY hosted session token error', async () => {
    isolateConfig();
    await expect(resolveByokConfig({ provider: 'joy-hosted' })).rejects.toThrow(
      'run `joy-media login` or set JOY_MEDIA_SESSION_TOKEN',
    );
  });

  it('does not route Anthropic or Kilo to api.openai.com', () => {
    isolateConfig();
    expect(() =>
      describeEffectiveConfig({ provider: 'anthropic', baseUrl: 'https://api.openai.com/v1' }),
    ).toThrow();
    expect(() =>
      describeEffectiveConfig({ provider: 'kilo', baseUrl: 'https://api.openai.com/v1' }),
    ).toThrow();
  });
});
