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
  for (const key of ['KILO_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
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
    ({ env, provider, source }) => {
      isolateConfig();
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const description = describeEffectiveConfig();
      const resolved = resolveByokConfig();
      expect(description).toMatchObject({ provider, source });
      expect(description.modelId).toBe(resolved.modelId);
      expect(description.baseUrl).toBe(resolved.baseUrl);
      expect(resolved.modelId).toBe(
        provider === 'kilo' ? DEFAULT_KILO_MODEL : DEFAULT_OPENROUTER_MODEL,
      );
    },
  );

  it('uses the BytePlus creative preset for a Kilo provider', () => {
    isolateConfig();
    const resolved = resolveByokConfig({ provider: 'kilo', apiKey: 'k' });
    expect(resolved).toMatchObject({
      baseUrl: KILO_GATEWAY_BASE_URL,
      modelId: 'byteplus-coding/dola-seed-2.0-pro',
    });
  });
});
