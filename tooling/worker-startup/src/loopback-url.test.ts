import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

/**
 * T-F24: the Local service is reached at http://127.0.0.1:<port> with no path. The SEA bootstrap
 * refuses any path, including a trailing slash. The check runs before any file is written.
 */

const bootstrap = resolve(process.cwd(), 'scripts/worker-sea-bootstrap.cjs');

function bootstrapWith(apiUrl: string) {
  return spawnSync(process.execPath, [bootstrap], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      JOY_MEDIA_API_URL: apiUrl,
      // A missing entry point ends the run after the URL check, so nothing is started.
      JOY_MEDIA_WORKER_ENTRYPOINT: join(tmpdir(), 'joy-media-no-such-entrypoint.js'),
      JOY_MEDIA_WORKER_STATE_PATH: join(tmpdir(), 'joy-media-loopback-test', 'worker-state.json'),
    },
  });
}

describe('the Local service URL has no path (T-F24)', () => {
  it('refuses a trailing slash', () => {
    const result = bootstrapWith('http://127.0.0.1:8123/');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must be http://127.0.0.1:<port>');
  });

  it('refuses a path', () => {
    const result = bootstrapWith('http://127.0.0.1:8123/v1');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must be http://127.0.0.1:<port>');
  });

  it('accepts the bare loopback address and stops only at the missing entry point', () => {
    const result = bootstrapWith('http://127.0.0.1:8123');
    expect(result.stderr).not.toContain('must be http://127.0.0.1:<port>');
    expect(result.stderr).toContain('Worker entrypoint not found');
  });
});
