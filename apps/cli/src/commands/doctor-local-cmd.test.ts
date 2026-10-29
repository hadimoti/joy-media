import { spawnSync } from 'node:child_process';
import type * as nodeFs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDoctorLocalCommand } from './doctor-local-cmd.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync as typeof spawnSync) };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFs>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    lstatSync: vi.fn(actual.lstatSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
});

const SAVED_ENV = ['HOME', 'USERPROFILE', 'JOY_MODELS_DIR', 'JOY_MEDIA_SQLITE_PATH'];
let saved: Record<string, string | undefined> = {};
let home = '';

/** Runs the check as if on Windows, so the drive logic is exercised on every CI host. */
async function onWindows<T>(run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    return await run();
  } finally {
    if (original !== undefined) Object.defineProperty(process, 'platform', original);
  }
}

/** The drive list the fake query answers with: the test folder's drive is fixed, and Z: is a network drive. */
function driveList(): string {
  const drive = /^[A-Za-z]:/.exec(home)?.[0]?.toUpperCase();
  return `${drive === undefined ? '' : `${drive}=3`}\nZ:=4\n`;
}

/** Captures every line the check prints, so a test can assert on what the person sees. */
function captureOutput(): () => string {
  const lines: string[] = [];
  const record = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(record);
  vi.spyOn(console, 'warn').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);
  return () => lines.join('\n');
}

beforeEach(() => {
  saved = Object.fromEntries(SAVED_ENV.map((key) => [key, process.env[key]]));
  for (const key of SAVED_ENV) delete process.env[key];
  home = mkdtempSync(join(tmpdir(), 'joy-local-check-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  vi.clearAllMocks();
  vi.mocked(spawnSync).mockImplementation(((_file: string, args: readonly string[]) => ({
    status: 0,
    stdout: args.join(' ').includes('DriveInfo') ? driveList() : '',
  })) as unknown as typeof spawnSync);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  for (const key of SAVED_ENV) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('explicit local check', () => {
  it('refuses off Windows and reads nothing', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      captureOutput();
      expect(await handleDoctorLocalCommand()).toBe(2);
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'platform', original);
    }
    expect(vi.mocked(existsSync)).not.toHaveBeenCalled();
    expect(vi.mocked(readdirSync)).not.toHaveBeenCalled();
  });

  it('reports a network database path as not checked and never inspects it', async () => {
    process.env.JOY_MEDIA_SQLITE_PATH = 'Z:\\data\\joy.db';
    const output = captureOutput();

    await onWindows(() => handleDoctorLocalCommand());

    expect(output()).toContain('Desktop Project Store: not checked');
    const inspected = vi.mocked(existsSync).mock.calls.map(([path]) => String(path));
    expect(inspected.some((path) => path.startsWith('Z:'))).toBe(false);
  });

  it('reports a UNC model folder as not checked and never lists it', async () => {
    process.env.JOY_MODELS_DIR = '\\\\server\\share\\models';
    const output = captureOutput();

    await onWindows(() => handleDoctorLocalCommand());

    expect(output()).toContain('Local Model Weights: not checked');
    const listed = vi.mocked(readdirSync).mock.calls.map(([path]) => String(path));
    expect(listed.some((path) => path.startsWith('\\\\'))).toBe(false);
  });

  it('lists a local model folder', async () => {
    const models = join(home, 'JOY', 'models');
    mkdirSync(models, { recursive: true });
    writeFileSync(join(models, 'a.bin'), 'x');
    writeFileSync(join(models, 'b.bin'), 'y');
    process.env.JOY_MODELS_DIR = models;
    const output = captureOutput();

    await onWindows(() => handleDoctorLocalCommand());

    expect(output()).toContain('2 file(s) found');
  });

  it('does not read the provider settings through a junction', async () => {
    const target = join(home, 'elsewhere');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(home, '.joy-media'), 'junction');
    const output = captureOutput();

    await onWindows(() => handleDoctorLocalCommand());

    expect(output()).toContain('Joy Agent Provider: not checked');
    const inspected = vi.mocked(existsSync).mock.calls.map(([path]) => String(path));
    expect(inspected).not.toContain(join(home, '.joy-media', 'ai-providers.json'));
  });

  it('states what it cannot detect', async () => {
    const output = captureOutput();

    await onWindows(() => handleDoctorLocalCommand());

    expect(output()).toContain('cloud placeholder that downloads on first read');
    expect(output()).toContain('link created between the check and the read');
  });
});
