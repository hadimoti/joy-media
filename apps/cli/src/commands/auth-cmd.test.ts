import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { configureSecretStoreRuntimeForTests } from '../utils/secret-store.js';
import { loadJoySession, saveJoySession } from '../utils/config.js';

describe('CLI JOY session commands', () => {
  let home: string;
  let restoreSecretStore: (() => void) | undefined;
  let keyring: Map<string, string>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'joy-auth-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('JOY_MEDIA_API_BASE_URL', '');
    vi.stubEnv('JOY_MEDIA_API_URL', '');
    vi.stubEnv('JOY_MEDIA_SESSION_TOKEN', '');
    keyring = new Map();
    restoreSecretStore = configureSecretStoreRuntimeForTests({
      platform: 'linux',
      runner: (_command, args, stdin) => {
        if (args[0] === 'store') keyring.set(args.at(-1)!, stdin ?? '');
        if (args[0] === 'lookup') return { status: 0, stdout: keyring.get(args.at(-1)!) ?? '' };
        if (args[0] === 'clear') keyring.delete(args.at(-1)!);
        return { status: 0, stdout: '' };
      },
    });
  });

  afterEach(() => {
    restoreSecretStore?.();
    restoreSecretStore = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it('requests and verifies an OTP, then stores the session token without printing it', async () => {
    const token = 'tok-fake-never-print';
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.endsWith('/v1/auth/request-otp'))
        return new Response(JSON.stringify({ data: { message: 'Code requested.' } }), {
          status: 200,
        });
      if (url.endsWith('/v1/auth/verify-otp'))
        return new Response(JSON.stringify({ data: { token } }), { status: 200 });
      throw new Error('unexpected endpoint');
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await runCli([
      'login',
      '--email',
      'person@example.invalid',
      '--code',
      '123456',
      '--api-base',
      'https://api.example.invalid/api',
    ]);

    expect(result).toBe(0);
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.invalid/api/v1/auth/request-otp',
      'https://api.example.invalid/api/v1/auth/verify-otp',
    ]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      contact: 'person@example.invalid',
      method: 'gmail',
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      contact: 'person@example.invalid',
      method: 'gmail',
      code: '123456',
    });
    expect(keyring.get('joy-media-session')).toBe(token);
    expect(JSON.stringify(output.mock.calls)).not.toContain(token);
    expect(JSON.stringify(calls.map((call) => call.init?.body))).not.toContain(token);
  });

  it('returns a non-zero exit code for a rejected OTP without echoing the code', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('/v1/auth/request-otp')
        ? new Response(JSON.stringify({ data: { message: 'Code requested.' } }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: 'invalid code' } }), { status: 401 }),
    );
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runCli(['login', '--email', 'person@example.invalid', '--code', '123456']);

    expect(result).not.toBe(0);
    expect(JSON.stringify(output.mock.calls)).not.toContain('123456');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('123456');
    expect(keyring.has('joy-media-session')).toBe(false);
  });

  it('uses the API URL environment override and asks for insecure storage consent when no keyring exists', async () => {
    vi.stubEnv('JOY_MEDIA_API_BASE_URL', 'https://api-env.example.invalid/api');
    restoreSecretStore?.();
    restoreSecretStore = configureSecretStoreRuntimeForTests({
      platform: 'linux',
      runner: () => ({ status: 1, stdout: '' }),
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('/v1/auth/request-otp')
        ? new Response(JSON.stringify({ data: { message: 'Code requested.' } }), { status: 200 })
        : new Response(JSON.stringify({ data: { token: 'session-test-no-keyring' } }), {
            status: 200,
          }),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runCli(['login', '--email', 'person@example.invalid', '--code', '123456']);

    expect(result).not.toBe(0);
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(
      'https://api-env.example.invalid/api/v1/auth/request-otp',
    );
    expect(JSON.stringify(errors.mock.calls)).toContain('--insecure-file-store');
    expect(keyring.has('joy-media-session')).toBe(false);
  });

  it('shows identity and subscription details from the desktop identity endpoints as JSON', async () => {
    saveJoySession({ token: 'tok-fake-1', email: 'person@example.invalid' });
    expect(loadJoySession()?.token).toBe('tok-fake-1');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      return url.endsWith('/v1/auth/session')
        ? new Response(
            JSON.stringify({ data: { contact: 'person@example.invalid', method: 'gmail' } }),
            { status: 200 },
          )
        : new Response(JSON.stringify({ data: { plan: 'monthly', status: 'active' } }), {
            status: 200,
          });
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runCli([
      'whoami',
      '--json',
      '--api-base',
      'https://api.example.invalid/api',
    ]);

    expect(result).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
      email: 'person@example.invalid',
      plan: 'monthly',
      subscriptionStatus: 'active',
    });
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.invalid/api/v1/auth/session',
      'https://api.example.invalid/api/v1/account/subscription',
    ]);
    expect(
      calls.every(
        (call) =>
          (call.init?.headers as Record<string, string>).authorization === 'Bearer tok-fake-1',
      ),
    ).toBe(true);
    expect(JSON.stringify(output.mock.calls)).not.toContain('tok-fake-1');
  });

  it('clears an expired session and tells the user to log in again', async () => {
    saveJoySession({ token: 'session-test-expired' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'authentication required' } }), {
        status: 401,
      }),
    );
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runCli(['whoami']);

    expect(result).not.toBe(0);
    expect(keyring.has('joy-media-session')).toBe(false);
    expect(`${JSON.stringify(output.mock.calls)}${JSON.stringify(errors.mock.calls)}`).toContain(
      'joy-media login',
    );
  });

  it('revokes a stored session on logout and treats a second logout as success', async () => {
    saveJoySession({ token: 'tok-fake-1' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));

    expect(await runCli(['logout'])).toBe(0);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://joyst.ir/api/v1/auth/logout',
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: 'Bearer tok-fake-1' },
      }),
    );
    expect(keyring.has('joy-media-session')).toBe(false);
    fetchSpy.mockClear();
    expect(await runCli(['logout'])).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
