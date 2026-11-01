import { spawnSync } from 'node:child_process';
import dns from 'node:dns';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDoctorCommand } from './doctor-cmd.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync as typeof spawnSync) };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync as typeof existsSync),
    lstatSync: vi.fn(actual.lstatSync as typeof lstatSync),
    readdirSync: vi.fn(actual.readdirSync as typeof readdirSync),
    readFileSync: vi.fn(actual.readFileSync as typeof readFileSync),
    statSync: vi.fn(actual.statSync as typeof statSync),
  };
});

const SAVED_ENV = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'SystemRoot',
  'PSModulePath',
  'PSMODULEPATH',
  'JOY_MODELS_DIR',
  'JOY_MEDIA_SQLITE_PATH',
];
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const PS_MODULES = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';

let saved: Record<string, string | undefined> = {};

/** Runs the check as if on the given platform, so the Windows branch is exercised on every CI host. */
async function onPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await run();
  } finally {
    if (original !== undefined) Object.defineProperty(process, 'platform', original);
  }
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

/**
 * Replaces each network API the check could reach with a spy that throws. The named ESM exports are
 * synced, so a module that imports one by name reaches the spy too.
 */
function blockNetwork(): Array<{
  readonly name: string;
  readonly spy: { mock: { calls: unknown[] } };
}> {
  const blocked: Array<{ readonly name: string; readonly spy: { mock: { calls: unknown[] } } }> =
    [];
  const block = (name: string, target: object, method: string): void => {
    const spy = vi
      .spyOn(target as unknown as Record<string, (...args: unknown[]) => unknown>, method)
      .mockImplementation(() => {
        throw new Error(`network call blocked: ${name}`);
      });
    blocked.push({ name, spy });
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
  for (const key of SAVED_ENV) delete process.env[key];
  vi.clearAllMocks();
  vi.mocked(spawnSync).mockImplementation((() => ({
    status: 0,
    stdout: 'NVIDIA GeForce',
    stderr: '',
  })) as unknown as typeof spawnSync);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of SAVED_ENV) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('default doctor', () => {
  it('reads no user path, even when the environment points at network locations', async () => {
    captureOutput();
    process.env.HOME = 'C:\\Users\\tester';
    process.env.USERPROFILE = 'C:\\Users\\tester';
    process.env.APPDATA = '\\\\server\\roaming';
    process.env.JOY_MODELS_DIR = '\\\\server\\share\\models';
    process.env.JOY_MEDIA_SQLITE_PATH = 'Z:\\data\\joy.db';

    await onPlatform('win32', () => handleDoctorCommand());

    expect(vi.mocked(existsSync)).not.toHaveBeenCalled();
    expect(vi.mocked(lstatSync)).not.toHaveBeenCalled();
    expect(vi.mocked(readdirSync)).not.toHaveBeenCalled();
    expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(statSync)).not.toHaveBeenCalled();
  });

  it('makes no network call', async () => {
    captureOutput();
    const blocked = blockNetwork();

    await onPlatform('win32', () => handleDoctorCommand());

    for (const { name, spy } of blocked) expect(spy.mock.calls, name).toHaveLength(0);
  });

  it('starts one fixed PowerShell program with one pinned module path, whatever the environment says', async () => {
    captureOutput();
    process.env.SystemRoot = '\\\\server\\root';
    process.env.PSModulePath = '\\\\server\\modules';
    process.env.PSMODULEPATH = '\\\\server\\other';

    await onPlatform('win32', () => handleDoctorCommand());

    const call = vi.mocked(spawnSync).mock.calls[0];
    expect(call?.[0]).toBe(POWERSHELL);
    const options = call?.[2] as { readonly env: NodeJS.ProcessEnv };
    const spellings = Object.keys(options.env).filter(
      (name) => name.toUpperCase() === 'PSMODULEPATH',
    );
    expect(spellings).toEqual(['PSModulePath']);
    expect(options.env.PSModulePath).toBe(PS_MODULES);
  });

  it('checks the GPU only on Windows and starts no process elsewhere', async () => {
    const output = captureOutput();

    await onPlatform('linux', () => handleDoctorCommand());

    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
    expect(output()).toContain('not checked on this platform');
  });

  it('points to the explicit local check instead of reading local files', async () => {
    const output = captureOutput();

    await onPlatform('win32', () => handleDoctorCommand());

    expect(output()).toContain('joy-media doctor-local');
  });
});
