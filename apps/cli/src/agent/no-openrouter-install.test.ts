import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import {
  getAiProvidersPath,
  getCliConfigPath,
  getJoyMediaDir,
  loadAiProviders,
  setAiProvider,
} from '../utils/config.js';
import { loadAgentSlots } from './agent-slots.js';
import { resolveByokConfig } from './provider.js';

const savedEnvironment = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

describe('first CLI install without an OpenRouter profile or key', () => {
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'joy-no-openrouter-install-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('starts with two empty slots and binds Workhorse to a keyless local profile', async () => {
    expect(loadAiProviders()).toEqual({});
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(loadAgentSlots()).toMatchObject({
      workhorse: { profileId: undefined, model: undefined },
      creative: { profileId: undefined, model: undefined },
    });
    expect(existsSync(getAiProvidersPath())).toBe(false);
    expect(await runCli(['agent', 'slot', 'list'])).toBe(0);

    setAiProvider('local-only', {
      name: 'Local only',
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:1234/v1',
    });
    expect(
      await runCli([
        'agent',
        'slot',
        'set',
        'workhorse',
        '--profile',
        'local-only',
        '--model',
        'local-model',
      ]),
    ).toBe(0);
    expect(resolveByokConfig({ slot: 'workhorse' })).toMatchObject({
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:1234/v1',
      modelId: 'local-model',
      apiKey: '',
    });

    const providerPath = getAiProvidersPath();
    const configPath = getCliConfigPath();
    const credentialsPath = join(getJoyMediaDir(), 'credentials.json');
    const persisted = [providerPath, configPath, credentialsPath]
      .filter(existsSync)
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    expect(loadAiProviders()).not.toHaveProperty('openrouter');
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(persisted.toLowerCase()).not.toContain('openrouter');
    expect(persisted).not.toContain('OPENROUTER_API_KEY');
    expect(persisted).not.toContain('sk-or-');
    expect(existsSync(credentialsPath)).toBe(false);
  });
});
