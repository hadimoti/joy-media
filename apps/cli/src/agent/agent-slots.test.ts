import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_SLOT_IDS,
  PROVIDER_REGISTRY,
  isAuthMethodPermitted,
  offeredAuthMethods,
  permittedAuthMethods,
} from '@joy-media/provider-sdk';
import { runCli } from '../cli.js';
import { saveCliConfig, setAiProvider } from '../utils/config.js';
import { clearAgentSlot, loadAgentSlot, loadAgentSlots, saveAgentSlot } from './agent-slots.js';
import { isRetiredProvider, resolveByokConfig } from './provider.js';

const PROVIDER_SLOT_CASES = PROVIDER_REGISTRY.flatMap(({ id }) =>
  AGENT_SLOT_IDS.map((slotId) => ({ providerId: id, slotId })),
);

/** Each test runs against its own home directory, so the owner's real configuration is never read or written. */
const savedEnvironment = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  JOY_MEDIA_HOME: process.env.JOY_MEDIA_HOME,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

describe('agent slots in the CLI', () => {
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'joy-agent-slots-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.JOY_MEDIA_HOME = join(home, '.joy-media');
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    setAiProvider('local-a', {
      name: 'local-a',
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:1234/v1',
    });
    setAiProvider('local-b', {
      name: 'local-b',
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:5678/v1',
    });
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('starts with two empty slots that cannot run', () => {
    const slots = loadAgentSlots();
    expect(slots.workhorse).toMatchObject({ label: 'Workhorse', profileId: undefined });
    expect(slots.creative).toMatchObject({ label: 'Creative Brain', profileId: undefined });
    expect(() => resolveByokConfig({ slot: 'workhorse' })).toThrow('has no profile or model');
  });

  it('saves a slot, reads it back, and clears it', () => {
    const result = saveAgentSlot('creative', {
      profileId: 'local-a',
      model: 'local-model',
      instructions: 'Be brief.',
      settings: { temperature: 0.3 },
    });
    expect(result.ok).toBe(true);
    expect(loadAgentSlot('creative')).toMatchObject({
      profileId: 'local-a',
      model: 'local-model',
      instructions: 'Be brief.',
      settings: { temperature: 0.3 },
    });
    clearAgentSlot('creative');
    expect(loadAgentSlot('creative').profileId).toBeUndefined();
  });

  it('refuses a draft that breaks the rules and leaves the saved slot as it was', () => {
    saveAgentSlot('workhorse', { profileId: 'local-a', model: 'model-1' });
    expect(saveAgentSlot('workhorse', { settings: { temperature: 9 } })).toMatchObject({
      ok: false,
      field: 'settings',
    });
    expect(loadAgentSlot('workhorse').model).toBe('model-1');
  });

  it('reads a saved slot that no longer passes the rules as empty', () => {
    saveCliConfig({ agentSlots: { workhorse: { model: 'x'.repeat(300) } } });
    expect(loadAgentSlot('workhorse').model).toBeUndefined();
  });

  it('runs a slot with its own profile and model', () => {
    saveAgentSlot('workhorse', { profileId: 'local-a', model: 'slot-model' });
    expect(resolveByokConfig({ slot: 'workhorse' })).toMatchObject({
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:1234/v1',
      modelId: 'slot-model',
    });
  });

  it('resolves Claude through Anthropic Messages with an API key', () => {
    setAiProvider('claude-profile', {
      name: 'Claude',
      provider: 'claude',
      baseUrl: 'https://api.anthropic.com/v1',
    });

    expect(
      resolveByokConfig({
        provider: 'claude-profile',
        model: 'claude-test',
        apiKey: 'test-anthropic-key',
      }),
    ).toMatchObject({
      provider: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com/v1',
      modelId: 'claude-test',
      apiKey: 'test-anthropic-key',
    });
  });

  it('refuses ChatGPT sign-in in the CLI with a clear desktop direction', () => {
    setAiProvider('chatgpt-profile', {
      name: 'ChatGPT',
      provider: 'chatgpt',
      baseUrl: 'https://api.openai.com/v1',
    });

    expect(() =>
      resolveByokConfig({
        provider: 'chatgpt-profile',
        model: 'gpt-5',
        apiKey: 'not-used',
      }),
    ).toThrow('ChatGPT sign-in is not available in the CLI. Use the desktop app for ChatGPT.');
  });

  it('keeps the two slots independent, with their own profiles and models', () => {
    saveAgentSlot('workhorse', { profileId: 'local-a', model: 'model-a' });
    saveAgentSlot('creative', { profileId: 'local-b', model: 'model-b' });
    expect(resolveByokConfig({ slot: 'workhorse' })).toMatchObject({
      baseUrl: 'http://127.0.0.1:1234/v1',
      modelId: 'model-a',
    });
    expect(resolveByokConfig({ slot: 'creative' })).toMatchObject({
      baseUrl: 'http://127.0.0.1:5678/v1',
      modelId: 'model-b',
    });
  });

  it.each(PROVIDER_SLOT_CASES)(
    'resolves the $providerId registry auth policy through the $slotId slot',
    ({ providerId, slotId }) => {
      const provider = PROVIDER_REGISTRY.find((item) => item.id === providerId);
      if (provider === undefined) throw new Error(`Missing registry provider: ${providerId}`);
      const region = provider.regions[0];
      const profileId = `profile-${providerId}`;
      const model = `test-model-${providerId}`;
      const apiKey = `test-key-${providerId}-${slotId}`;
      const apiKeyPermitted = isAuthMethodPermitted(providerId, 'api-key');

      expect(permittedAuthMethods(providerId)).toEqual(provider.auth.methods);
      expect(offeredAuthMethods(providerId)).toEqual(
        provider.auth.gated ? [] : provider.auth.methods,
      );
      setAiProvider(profileId, {
        name: provider.label,
        provider: providerId,
        baseUrl: region.baseUrl,
        defaultModel: model,
        ...(apiKeyPermitted ? { apiKey } : {}),
      });
      expect(saveAgentSlot(slotId, { profileId, model }).ok).toBe(true);
      expect(loadAgentSlot(slotId)).toMatchObject({ profileId, model });

      if (isRetiredProvider(providerId)) {
        expect(() => resolveByokConfig({ slot: slotId })).toThrow(
          `The ${providerId} provider was retired from JOY Media.`,
        );
        return;
      }

      if (apiKeyPermitted) {
        const resolved = resolveByokConfig({ slot: slotId });
        expect(resolved).toMatchObject({
          baseUrl: region.baseUrl,
          modelId: model,
          apiKey,
        });
        expect(resolved.thinkingMode).toBe(providerId === 'deepseek' ? 'disabled' : undefined);
      } else {
        expect(provider.auth.methods).toContain('subscription-sign-in');
        expect(provider.auth.gated).toBe(true);
        expect(() => resolveByokConfig({ slot: slotId })).toThrow(
          'ChatGPT sign-in is not available in the CLI. Use the desktop app for ChatGPT.',
        );
      }
    },
  );

  it('keeps the S8 consent check on a public custom profile bound to a slot', () => {
    setAiProvider('public-custom', {
      name: 'Public custom',
      provider: 'custom',
      baseUrl: 'https://provider.example/v1',
      defaultModel: 'public-model',
      apiKey: 'public-custom-test-key',
    });
    saveAgentSlot('workhorse', { profileId: 'public-custom', model: 'public-model' });

    expect(() => resolveByokConfig({ slot: 'workhorse' })).toThrow(
      'The base URL of "public-custom" is refused: A public endpoint needs your explicit consent before any key is sent to it.',
    );
  });

  it('sets, lists and clears a slot through the command line, without opening a project', async () => {
    const setCode = await runCli([
      'agent',
      'slot',
      'set',
      'creative',
      '--profile',
      'local-a',
      '--model',
      'cli-model',
      '--temperature',
      '0.5',
      '--max-output-tokens',
      '800',
      '--instructions',
      'Plain words.',
    ]);
    expect(setCode).toBe(0);
    expect(loadAgentSlot('creative')).toMatchObject({
      profileId: 'local-a',
      model: 'cli-model',
      instructions: 'Plain words.',
      settings: { temperature: 0.5, maxOutputTokens: 800 },
    });
    expect(await runCli(['agent', 'slot', 'list'])).toBe(0);
    expect(await runCli(['agent', 'slot', 'set', 'creative', '--profile', 'missing'])).toBe(1);
    expect(await runCli(['agent', 'slot', 'set', 'creative', '--temperature', ''])).toBe(1);
    expect(await runCli(['agent', 'slot', 'clear', 'creative'])).toBe(0);
    expect(loadAgentSlot('creative').profileId).toBeUndefined();
  });

  it('refuses a slot combined with an explicit provider', () => {
    saveAgentSlot('workhorse', { profileId: 'local-a', model: 'model-a' });
    expect(() => resolveByokConfig({ slot: 'workhorse', provider: 'local-b' })).toThrow(
      'either an agent slot or a provider',
    );
  });
});
