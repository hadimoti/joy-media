import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

describe('retired real-service scripts', () => {
  it.each([
    'ops/self-hosted/linux-runner/real-service-acceptance.mjs',
    'ops/self-hosted/linux-runner/real-service-smoke.mjs',
  ])('%s exits with an actionable retirement message', (relativePath) => {
    const result = spawnSync(process.execPath, [resolve(repositoryRoot, relativePath)], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    expect(result.status).toBe(2);
    expect(output).toContain('retired');
    expect(output).toContain('PLAN-v4 §8b');
    expect(output).not.toContain('ERR_MODULE_NOT_FOUND');
  });
});
