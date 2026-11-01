import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Starts the real entry point and reports how it ended. The state path is private to the run, so the
 * result also says whether the Worker wrote any state before it refused its setup.
 */
function startWorker(env: Record<string, string>): {
  readonly status: number | null;
  readonly stderr: string;
  readonly stateWritten: boolean;
} {
  const scratch = mkdtempSync(join(tmpdir(), 'joy-worker-start-'));
  try {
    const statePath = join(scratch, 'worker-state.json');
    const inherited: NodeJS.ProcessEnv = { ...process.env };
    delete inherited.JOY_MEDIA_API_URL;
    delete inherited.JOY_MEDIA_WORKER_LOCAL_TOKEN;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(workerRoot, 'src', 'index.ts')],
      {
        cwd: workerRoot,
        env: { ...inherited, JOY_MEDIA_WORKER_STATE_PATH: statePath, ...env },
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    return { status: result.status, stderr: result.stderr, stateWritten: existsSync(statePath) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe('Worker entry point', () => {
  it('refuses a remote control plane before any state is written, even with a local token', () => {
    const run = startWorker({
      JOY_MEDIA_API_URL: 'https://user:secret@api.joyst.ir/api',
      JOY_MEDIA_WORKER_LOCAL_TOKEN: 'run-token',
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('remote URLs are refused');
    expect(run.stderr).not.toContain('secret');
    expect(run.stateWritten).toBe(false);
  });

  it('names the missing loopback URL and writes no state', () => {
    const run = startWorker({ JOY_MEDIA_WORKER_LOCAL_TOKEN: 'run-token' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('JOY_MEDIA_API_URL is required');
    expect(run.stateWritten).toBe(false);
  });

  it('names the missing local token and writes no state', () => {
    const run = startWorker({ JOY_MEDIA_API_URL: 'http://127.0.0.1:4174' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('JOY_MEDIA_WORKER_LOCAL_TOKEN is required');
    expect(run.stateWritten).toBe(false);
  });
});
