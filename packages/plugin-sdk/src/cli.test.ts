import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('joy-plugin CLI', () => {
  it('creates a panel package from the published scaffold', () => {
    const output = mkdtempSync(join(tmpdir(), 'joy-plugin-cli-'));
    const bin = fileURLToPath(new URL('../bin/joy-plugin.mjs', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [bin, 'init', output, 'example.panel', 'Example Panel', 'Example'],
      {
        encoding: 'utf8',
        shell: false,
      },
    );
    expect(result.status).toBe(0);
    expect(existsSync(join(output, 'plugin.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(output, 'plugin.json'), 'utf8'))).toMatchObject({
      id: 'example.panel',
      permissions: ['ui.panel'],
    });
  });
});
