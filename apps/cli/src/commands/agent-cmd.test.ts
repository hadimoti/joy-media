import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli.js';
import { setAiProvider } from '../utils/config.js';

/** The key the listing must never show, not even a part of one (PLAN-v4 §6d-1). */
const SECRET = 'sk-or-cli-secret-0123456789abcdef';

/** Each test runs against its own home directory, so the owner's real configuration is never read or written. */
const savedEnvironment = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

describe('the CLI provider listing', () => {
  let home = '';
  let printed: string[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'joy-provider-list-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    printed = [];
    const record = (...args: unknown[]): void => {
      printed.push(args.map(String).join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(console, 'warn').mockImplementation(record);
    vi.spyOn(console, 'error').mockImplementation(record);
    setAiProvider('openrouter', {
      name: 'openrouter',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: SECRET,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [name, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('lists a provider with a key without printing any character of that key', async () => {
    const code = await runCli(['agent', 'provider', 'list']);
    expect(code).toBe(0);
    const output = printed.join('\n');
    // The provider is listed, and the key is reported as present, so this cannot pass vacuously.
    expect(output).toContain('openrouter');
    expect(output).toContain('API Key');
    expect(output).toContain('set (hidden)');
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(SECRET.slice(0, 4));
    expect(output).not.toContain(SECRET.slice(-4));
  });
});
