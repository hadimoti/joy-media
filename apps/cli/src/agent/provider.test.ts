import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_KILO_MODEL,
  KILO_GATEWAY_BASE_URL,
  DEFAULT_OPENROUTER_MODEL,
} from '@joy-media/joy-agent-engine';
import { resolveByokConfig, describeEffectiveConfig } from './provider.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
      const resolved = await resolveByokConfig();
      expect(description).toMatchObject({ provider, source });
      expect(description.modelId).toBe(resolved.modelId);
      expect(description.baseUrl).toBe(resolved.baseUrl);
      expect(resolved.modelId).toBe(
        provider === 'kilo' ? DEFAULT_KILO_MODEL : DEFAULT_OPENROUTER_MODEL,
      );
    },
  );

  it('uses the BytePlus creative preset for a Kilo provider', async () => {
    isolateConfig();
    const resolved = await resolveByokConfig({ provider: 'kilo', apiKey: 'k' });
    expect(resolved).toMatchObject({
      baseUrl: KILO_GATEWAY_BASE_URL,
      modelId: 'byteplus-coding/dola-seed-2.0-pro',
    });
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
    vi.stubEnv('JOY_MEDIA_SESSION_TOKEN', 'session-test-REDACTED');
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
        apiKey: 'session-test-REDACTED',
        vision: true,
      });
      await resolveByokConfig({ provider: 'joy-hosted' });
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('uses the hosted catalog vision flag for an explicitly selected model', async () => {
    isolateConfig();
    vi.stubEnv('JOY_MEDIA_SESSION_TOKEN', 'session-test-REDACTED');
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
      'set JOY_MEDIA_SESSION_TOKEN',
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
