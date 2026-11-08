import { spawnSync } from 'node:child_process';
import type * as NodeFs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAiProviders, updateAiProviders } from './config.js';

// Errors to throw from the next attempts to create the config lock directory, consumed in order.
const lockFaults = vi.hoisted(() => ({ next: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    mkdirSync: vi.fn((...args: Parameters<typeof actual.mkdirSync>) => {
      if (String(args[0]).endsWith('.config.lock')) {
        const code = lockFaults.next.shift();
        if (code)
          throw Object.assign(new Error(`${code}: injected while creating the config lock`), {
            code,
          });
      }
      return Reflect.apply(actual.mkdirSync, actual, args) as unknown;
    }),
  };
});

let home: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

function lockDir(): string {
  return join(home, '.joy-media', '.config.lock');
}

function ownerFile(): string {
  return join(lockDir(), 'owner');
}

function plantLock(owner?: { pid: number }): void {
  mkdirSync(lockDir(), { recursive: true });
  if (owner) writeFileSync(ownerFile(), JSON.stringify(owner));
}

function agedLock(): void {
  const past = new Date(Date.now() - 60_000);
  utimesSync(lockDir(), past, past);
}

/** The PID of a child that has already exited, so no live process owns it. */
function exitedPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

function addProbeProvider(): void {
  updateAiProviders((providers) => {
    providers.probe = { provider: 'test' };
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'joy-config-lock-'));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  lockFaults.next.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  rmSync(home, { recursive: true, force: true });
});

describe('config write lock', () => {
  it('takes over a lock whose owner process has exited', () => {
    plantLock({ pid: exitedPid() });
    addProbeProvider();
    expect(loadAiProviders()).toHaveProperty('probe');
    expect(existsSync(lockDir())).toBe(false);
  });

  it('does not take over a lock whose owner is alive, however old the lock looks', () => {
    plantLock({ pid: process.pid });
    agedLock();
    // Each clock read advances 20 s, so the 15 s wait ends at once instead of after 15 real seconds.
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 20_000));
    expect(() => addProbeProvider()).toThrow(/Timed out waiting for the config lock/);
    expect(existsSync(ownerFile())).toBe(true);
  });

  it('takes over an old lock that has no owner record', () => {
    plantLock();
    agedLock();
    addProbeProvider();
    expect(loadAiProviders()).toHaveProperty('probe');
    expect(existsSync(lockDir())).toBe(false);
  });

  it('retries a transient EPERM or EBUSY while creating the lock', () => {
    lockFaults.next.push('EPERM', 'EBUSY');
    addProbeProvider();
    expect(lockFaults.next).toEqual([]);
    expect(loadAiProviders()).toHaveProperty('probe');
    expect(existsSync(lockDir())).toBe(false);
  });

  it('fails at once on any other error creating the lock', () => {
    lockFaults.next.push('EACCES', 'EACCES');
    expect(() => addProbeProvider()).toThrow(/EACCES: injected/);
    expect(lockFaults.next).toEqual(['EACCES']);
  });

  it('releases the lock when the write fails', () => {
    expect(() =>
      updateAiProviders(() => {
        throw new Error('mutation failed');
      }),
    ).toThrow('mutation failed');
    expect(existsSync(lockDir())).toBe(false);
  });
});
