/**
 * doctor's exit-code rule for a FAILED check (warnings alone exit 0; see
 * doctor-worker.e2e.test.ts). A broken SQLite engine cannot be produced on a
 * real machine on demand, so this runs in-process with `node:sqlite` mocked.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:sqlite', () => ({
  DatabaseSync: class {
    constructor() {
      throw new Error('sqlite engine missing');
    }
  },
}));

const { runCli } = await import('../cli.js');

describe('doctor with a failing core check', () => {
  const savedEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    JOY_MEDIA_EDGE_URL: process.env.JOY_MEDIA_EDGE_URL,
  };
  let home: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'joy-doctor-fail-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.JOY_MEDIA_EDGE_URL = 'off';
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('exits 1 and names the failed check on stderr', async () => {
    const code = await runCli(['doctor']);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/Built-in SQLite Engine: Error: sqlite engine missing/);
    expect(err.join('\n')).toMatch(/1 diagnostic check\(s\) failed: sqlite\./);
    expect(out.join('\n')).not.toMatch(/passed/);
  });

  it('--json reports ok:false with the failing check and still exits 1', async () => {
    const code = await runCli(['doctor', '--json']);
    expect(code).toBe(1);
    expect(out).toHaveLength(1);
    const doc = JSON.parse(out[0]!) as {
      ok: boolean;
      summary: { fail: number };
      checks: Array<{ id: string; status: string }>;
    };
    expect(doc.ok).toBe(false);
    expect(doc.summary.fail).toBe(1);
    expect(doc.checks.find((c) => c.id === 'sqlite')?.status).toBe('fail');
    // The failure is also explained on stderr, in one line.
    expect(err).toEqual([expect.stringMatching(/1 diagnostic check\(s\) failed: sqlite\./)]);
  });
});
