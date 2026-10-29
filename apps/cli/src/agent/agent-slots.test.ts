import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import { saveCliConfig, setAiProvider } from '../utils/config.js';
import { clearAgentSlot, loadAgentSlot, loadAgentSlots, saveAgentSlot } from './agent-slots.js';
import { resolveByokConfig } from './provider.js';

/** Each test runs against its own home directory, so the owner's real configuration is never read or written. */
const savedEnvironment = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

describe('agent slots in the CLI', () => {
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'joy-agent-slots-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
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
