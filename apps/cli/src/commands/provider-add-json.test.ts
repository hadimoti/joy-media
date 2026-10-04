import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';

describe('agent provider add --json', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'joy-provider-json-'));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('prints only JSON records to stdout', async () => {
    vi.stubEnv('HOME', tempDir);
    vi.stubEnv('USERPROFILE', tempDir);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ data: [{ id: 'model-one' }] }), { status: 200 }),
      ),
    );
    const output: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
      output.push(args.join(' '));
    });

    expect(
      await runCli([
        'agent',
        'provider',
        'add',
        'custom-json',
        '--url',
        'https://provider.invalid/v1',
        '--json',
      ]),
    ).toBe(0);
    expect(output).toHaveLength(1);
    expect(() => JSON.parse(output[0]!)).not.toThrow();
    expect(JSON.parse(output[0]!)).toMatchObject({
      type: 'provider',
      name: 'custom-json',
      baseUrl: 'https://provider.invalid/v1',
      defaultModel: 'model-one',
      cachedModels: ['model-one'],
    });
    expect(output.join('\n')).not.toContain('configured successfully');
    expect(output.join('\n')).not.toContain('Base URL');
    expect(output.join('\n')).not.toContain('Discovered 1 models');
    log.mockRestore();
  });
});
