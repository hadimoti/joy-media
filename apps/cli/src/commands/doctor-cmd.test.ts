import { spawnSync } from 'node:child_process';
import dns from 'node:dns';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import http, { request as namedRequest } from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync as typeof spawnSync) };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync as typeof existsSync),
    readdirSync: vi.fn(actual.readdirSync as typeof readdirSync),
    lstatSync: vi.fn(actual.lstatSync as typeof lstatSync),
  };
});

const SAVED_ENV = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'SystemRoot',
  'JOY_MODELS_DIR',
  'JOY_MEDIA_SQLITE_PATH',
];
const SYSTEM_ROOT = 'C:\\Windows';
const POWERSHELL = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const PS_MODULES = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');

let home = '';
let saved: Record<string, string | undefined> = {};

/** The drive list the fake query answers with: the test folder's drive is fixed, and Z: is remote. */
function driveList(): string {
  const drive = /^[A-Za-z]:/.exec(home)?.[0]?.toUpperCase() ?? 'C:';
  return `${drive}=3\nZ:=4\n`;
}

/** Answers the doctor's two PowerShell queries: the drive list, and any other query with a GPU. */
function answerPowerShell(drives: string): void {
  vi.mocked(spawnSync).mockImplementation(((_file: string, args: readonly string[]) => ({
    status: 0,
    stdout: args.join(' ').includes('DriveInfo') ? drives : 'NVIDIA GeForce',
  })) as unknown as typeof spawnSync);
}

/** Captures every line the doctor prints, so that a test can assert on what the person sees. */
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

/**
 * Replaces each network API the doctor could reach with a spy that throws, so that no request
 * leaves the test process. The named ESM exports are synced, so a module that imports one by name
 * reaches the spy too.
 */
function blockNetwork(): Array<{ name: string; spy: MockInstance }> {
  const blocked: Array<{ name: string; spy: MockInstance }> = [];
  const block = (name: string, target: object, method: string): void => {
    const spy = vi
      .spyOn(target as unknown as Record<string, (...args: unknown[]) => unknown>, method)
      .mockImplementation(() => {
        throw new Error(`network call blocked: ${name}`);
      });
    blocked.push({ name, spy: spy as unknown as MockInstance });
  };
  block('http.request', http, 'request');
  block('http.get', http, 'get');
  block('https.request', https, 'request');
  block('https.get', https, 'get');
  block('net.connect', net, 'connect');
  block('net.createConnection', net, 'createConnection');
  block('net.Socket.connect', net.Socket.prototype, 'connect');
  block('tls.connect', tls, 'connect');
  block('dns.lookup', dns, 'lookup');
  block('dns.resolve', dns, 'resolve');
  syncBuiltinESMExports();
  return blocked;
}

beforeEach(() => {
  saved = Object.fromEntries(SAVED_ENV.map((key) => [key, process.env[key]]));
  home = mkdtempSync(join(tmpdir(), 'joy-doctor-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, 'AppData', 'Roaming');
  process.env.SystemRoot = SYSTEM_ROOT;
  delete process.env.JOY_MODELS_DIR;
  delete process.env.JOY_MEDIA_SQLITE_PATH;
  vi.clearAllMocks();
  answerPowerShell(driveList());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const key of SAVED_ENV) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('joy doctor (no network calls)', () => {
  it('makes no network call while it checks the system', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    captureOutput();
    const blocked = blockNetwork();
    const { handleDoctorCommand } = await import('./doctor-cmd.js');

    await handleDoctorCommand();

    expect(fetchSpy).not.toHaveBeenCalled();
    for (const { name, spy } of blocked) {
      expect(spy, name).not.toHaveBeenCalled();
    }
  });

  it('detects a call through each network API the instrumentation covers', () => {
    const blocked = blockNetwork();
    const call = (run: () => unknown): void => {
      try {
        run();
      } catch {
        // Each spy throws on purpose, so the call ends here and no request leaves the process.
      }
    };
    call(() => http.request('http://127.0.0.1:1'));
    call(() => http.get('http://127.0.0.1:1'));
    call(() => https.request('https://127.0.0.1:1'));
    call(() => https.get('https://127.0.0.1:1'));
    call(() => net.connect(1, '127.0.0.1'));
    call(() => net.createConnection(1, '127.0.0.1'));
    call(() => new net.Socket().connect(1, '127.0.0.1'));
    call(() => tls.connect(1, '127.0.0.1'));
    call(() => dns.lookup('localhost', () => undefined));
    call(() => dns.resolve('localhost', () => undefined));

    for (const { name, spy } of blocked) {
      expect(spy, name).toHaveBeenCalled();
    }
  });

  it('detects a call made through a named import', () => {
    const blocked = blockNetwork();
    const requestSpy = blocked.find(({ name }) => name === 'http.request')?.spy;

    try {
      namedRequest('http://127.0.0.1:1');
    } catch {
      // Blocked on purpose, as in the test above.
    }

    expect(requestSpy).toHaveBeenCalledTimes(1);
  });
});

describe('joy doctor (network and linked paths)', () => {
  it('does not read a UNC model directory', async () => {
    const unc = '\\\\server\\share\\models';
    process.env.JOY_MODELS_DIR = unc;
    const output = captureOutput();
    const { handleDoctorCommand } = await import('./doctor-cmd.js');

    await handleDoctorCommand();

    expect(output()).toContain('Local Model Weights: not checked (network or linked path)');
    expect(existsSync).not.toHaveBeenCalledWith(unc);
    expect(vi.mocked(lstatSync).mock.calls.some(([path]) => String(path).startsWith('\\\\'))).toBe(
      false,
    );
    expect(readdirSync).not.toHaveBeenCalled();
  });

  it('does not read a folder on a mapped network drive', async () => {
    process.env.JOY_MODELS_DIR = 'Z:\\models';
    const output = captureOutput();
    const { handleDoctorCommand } = await import('./doctor-cmd.js');

    await handleDoctorCommand();

    expect(output()).toContain('Local Model Weights: not checked (network or linked path)');
    expect(existsSync).not.toHaveBeenCalledWith('Z:\\models');
    expect(vi.mocked(lstatSync).mock.calls.some(([path]) => String(path).startsWith('Z:'))).toBe(
      false,
    );
    expect(readdirSync).not.toHaveBeenCalled();
  });

  it('does not read a folder reached through a junction', async () => {
    const target = join(home, 'remote-share');
    mkdirSync(join(target, 'models'), { recursive: true });
    const link = join(home, 'linked');
    symlinkSync(target, link, 'junction');
    const models = join(link, 'models');
    process.env.JOY_MODELS_DIR = models;
    const output = captureOutput();
    const { handleDoctorCommand } = await import('./doctor-cmd.js');

    await handleDoctorCommand();

    expect(output()).toContain('Local Model Weights: not checked (network or linked path)');
    expect(existsSync).not.toHaveBeenCalledWith(models);
    expect(vi.mocked(lstatSync)).toHaveBeenCalledWith(link, expect.anything());
  });

  it('does not read a relative folder that resolves onto a mapped network drive', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue('Z:\\work');
    process.env.JOY_MODELS_DIR = 'models';
    const output = captureOutput();
    const { handleDoctorCommand } = await import('./doctor-cmd.js');

    await handleDoctorCommand();

    expect(output()).toContain('Local Model Weights: not checked (network or linked path)');
    expect(readdirSync).not.toHaveBeenCalled();
    expect(vi.mocked(lstatSync).mock.calls.some(([path]) => String(path).startsWith('Z:'))).toBe(
      false,
    );
  });

  it('does not read a database path behind a UNC name', async () => {
    const unc = '\\\\server\\share\\joy-media.sqlite3';
    process.env.JOY_MEDIA_SQLITE_PATH = unc;
    const output = captureOutput();
    const { handleDoctorCommand } = await import('./doctor-cmd.js');

    await handleDoctorCommand();

    expect(output()).toContain('Desktop Project Store: not checked (network or linked path)');
    expect(existsSync).not.toHaveBeenCalledWith(unc);
  });

  it('does not read a relative database path that resolves onto a mapped network drive', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue('Z:\\work');
    process.env.JOY_MEDIA_SQLITE_PATH = 'joy-media.sqlite3';
    const output = captureOutput();
    const { handleDoctorCommand } = await import('./doctor-cmd.js');

    await handleDoctorCommand();

    expect(output()).toContain('Desktop Project Store: not checked (network or linked path)');
    expect(existsSync).not.toHaveBeenCalledWith('joy-media.sqlite3');
  });

  it('does not read the configuration folder when it is a junction', async () => {
    const target = join(home, 'remote-config');
    mkdirSync(target);
    symlinkSync(target, join(home, '.joy-media'), 'junction');
    const output = captureOutput();
    const { handleDoctorCommand } = await import('./doctor-cmd.js');

    await handleDoctorCommand();

    expect(output()).toContain('Desktop Project Store: not checked (network or linked path)');
    expect(output()).toContain('Joy Agent Provider: not checked (network or linked path)');
    expect(output()).toContain('Local AI Venvs: not checked (network or linked path)');
  });

  it('still reads a local model folder', async () => {
    const models = join(home, 'models');
    mkdirSync(models);
    writeFileSync(join(models, 'weights.bin'), 'x');
    process.env.JOY_MODELS_DIR = models;
    const output = captureOutput();
    const { handleDoctorCommand } = await import('./doctor-cmd.js');

    await handleDoctorCommand();

    expect(output()).toContain('Local Model Weights: 1 file(s) found in');
  });

  it('starts PowerShell only by its absolute path, with the module path pinned', async () => {
    captureOutput();
    const { handleDoctorCommand } = await import('./doctor-cmd.js');

    await handleDoctorCommand();

    const calls = vi.mocked(spawnSync).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [file, , options] of calls) {
      expect(file).toBe(POWERSHELL);
      expect(options?.env?.PSModulePath).toBe(PS_MODULES);
    }
  });

  it('does not trust a SystemRoot that is relative or a UNC path', async () => {
    process.env.SystemRoot = '\\\\server\\share\\Windows';
    captureOutput();
    const { handleDoctorCommand } = await import('./doctor-cmd.js');

    await handleDoctorCommand();

    const calls = vi.mocked(spawnSync).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [file] of calls) {
      expect(file).toBe(POWERSHELL);
    }
  });
});
