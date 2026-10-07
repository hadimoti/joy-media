import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { configureSecretStoreRuntimeForTests } from '../utils/secret-store.js';
import { configureAuthPromptsForTests } from './auth-cmd.js';
import { loadJoySession, saveJoySession } from '../utils/config.js';

describe('CLI JOY session commands', () => {
  let home: string;
  let restoreSecretStore: (() => void) | undefined;
  let keyring: Map<string, string>;
  let restorePrompts: (() => void) | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'joy-auth-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('JOY_MEDIA_API_BASE_URL', '');
    vi.stubEnv('JOY_MEDIA_API_URL', '');
    vi.stubEnv('JOY_MEDIA_SESSION_TOKEN', '');
    keyring = new Map();
    restorePrompts = configureAuthPromptsForTests({ interactive: () => false });
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
    restorePrompts?.();
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
      'https://api.example.invalid:8443/api',
    ]);

    expect(result).toBe(0);
    expect(loadJoySession()?.apiOrigin).toBe('https://api.example.invalid:8443');
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.invalid:8443/api/v1/auth/request-otp',
      'https://api.example.invalid:8443/api/v1/auth/verify-otp',
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
    expect(keyring.has('joy-media-session-probe')).toBe(false);
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
    expect(JSON.stringify(errors.mock.calls)).toContain('The login code was invalid or expired.');
    expect(JSON.stringify(output.mock.calls)).not.toContain('123456');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('123456');
    expect(keyring.has('joy-media-session')).toBe(false);
  });

  it('fails before requesting a code when no keyring is usable and plaintext was not opted in', async () => {
    vi.stubEnv('JOY_MEDIA_API_BASE_URL', 'https://api-env.example.invalid/api');
    restoreSecretStore?.();
    restoreSecretStore = configureSecretStoreRuntimeForTests({
      platform: 'linux',
      runner: () => ({ status: 1, stdout: '' }),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runCli(['login', '--email', 'person@example.invalid', '--code', '123456']);

    expect(result).not.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).toContain('--insecure-file-store');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('--api-key-env');
    expect(keyring.has('joy-media-session')).toBe(false);
  });

  it('uses the API URL environment override and stores plaintext only with --insecure-file-store', async () => {
    vi.stubEnv('JOY_MEDIA_API_BASE_URL', 'https://api-env.example.invalid/api');
    restoreSecretStore?.();
    restoreSecretStore = configureSecretStoreRuntimeForTests({
      platform: 'linux',
      runner: () => ({ status: 1, stdout: '' }),
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('/v1/auth/request-otp')
        ? new Response(JSON.stringify({ data: { message: 'Code requested.' } }), { status: 200 })
        : new Response(JSON.stringify({ data: { token: 'session-test-file-store' } }), {
            status: 200,
          }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runCli([
      'login',
      '--email',
      'person@example.invalid',
      '--code',
      '123456',
      '--insecure-file-store',
    ]);

    expect(result).toBe(0);
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(
      'https://api-env.example.invalid/api/v1/auth/request-otp',
    );
    expect(loadJoySession()?.token).toBe('session-test-file-store');
  });

  it.each([
    [['login', '--email', 'person@example.invalid'], 'Pass --code'],
    [['login', '--code', '123456'], 'Pass --email'],
    [['login', '--email', 'person@example.invalid', '--code', '12ab'], 'Invalid code'],
    [['login', '--email', 'not-an-email', '--code', '123456'], 'Invalid email address'],
    [
      ['login', '--email', 'a@example.invalid', '--code', '123456', '--api-base', 'ftp://x/api'],
      'API base URL must use HTTPS or localhost HTTP',
    ],
    [
      [
        'login',
        '--email',
        'a@example.invalid',
        '--code',
        '123456',
        '--api-base',
        'http://192.168.1.5:8080/api',
      ],
      'API base URL must use HTTPS or localhost HTTP',
    ],
    [
      ['login', '--email', 'a@example.invalid', '--code', '123456', '--api-base', 'not-a-url'],
      'Invalid API base URL',
    ],
  ])('validates %j locally without contacting the server', async (args, message) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runCli(args);

    expect(result).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).toContain(message);
  });

  it.each([
    [
      'a server error while sending the code',
      () => new Response(JSON.stringify({ error: { code: 'INTERNAL' } }), { status: 500 }),
      'The JOY server failed (HTTP 500) while sending the login code',
    ],
    [
      'a redirect',
      () =>
        new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid/' } }),
      'answered with a redirect (HTTP 302)',
    ],
    [
      'a missing endpoint',
      () => new Response('not found', { status: 404 }),
      'has no login endpoint (HTTP 404)',
    ],
    [
      'a rejected request',
      () => new Response(JSON.stringify({ error: { code: 'INVALID_CONTACT' } }), { status: 400 }),
      'The server rejected the login request (HTTP 400)',
    ],
    [
      'a network failure',
      () => {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      },
      'Could not reach the JOY API at https://joyst.ir (ECONNREFUSED)',
    ],
  ])('names %s on request-otp instead of blaming the email', async (_label, reply, message) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply());
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runCli(['login', '--email', 'person@example.invalid', '--code', '123456']);

    expect(result).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.stringify(errors.mock.calls);
    expect(printed).toContain(message);
    expect(printed).not.toContain('Login failed. Check the email and try again.');
    expect(printed).not.toContain('elsewhere.invalid');
  });

  it('reports a server error while checking the code instead of an invalid code', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('/v1/auth/request-otp')
        ? new Response(JSON.stringify({ data: { message: 'Code requested.' } }), { status: 200 })
        : new Response(JSON.stringify({ error: { code: 'INTERNAL' } }), { status: 503 }),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runCli(['login', '--email', 'person@example.invalid', '--code', '123456']);

    expect(result).toBe(1);
    const printed = JSON.stringify(errors.mock.calls);
    expect(printed).toContain('The JOY server failed (HTTP 503) while checking the login code');
    expect(printed).not.toContain('invalid or expired');
  });

  it('verifies a code without requesting a new one with --code-only', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ data: { token: 'session-test-code-only' } }), {
        status: 200,
      });
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runCli([
      'login',
      '--email',
      'person@example.invalid',
      '--code-only',
      '--code',
      '123456',
    ]);

    expect(result).toBe(0);
    expect(calls).toEqual(['https://joyst.ir/api/v1/auth/verify-otp']);
    expect(loadJoySession()?.token).toBe('session-test-code-only');
  });

  it('requires --code with --code-only when stdin is not a TTY', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runCli(['login', '--email', 'person@example.invalid', '--code-only']);

    expect(result).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).toContain('Pass --code with --code-only');
  });

  it('requests a code only with --request-code and explains how to finish', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ data: { message: 'Code requested.' } }), {
        status: 200,
      });
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runCli(['login', '--email', 'person@example.invalid', '--request-code']);

    expect(result).toBe(0);
    expect(calls).toEqual(['https://joyst.ir/api/v1/auth/request-otp']);
    expect(JSON.stringify(output.mock.calls)).toContain('--code-only');
    expect(loadJoySession()).toBeUndefined();
  });

  it('re-prompts for a mistyped code in the interactive flow without sending a new code', async () => {
    restorePrompts?.();
    const typed = ['000000', '123456'];
    restorePrompts = configureAuthPromptsForTests({
      interactive: () => true,
      code: async () => typed.shift() ?? '',
    });
    const calls: Array<{ url: string; code?: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as { code?: string }) : {};
      calls.push({ url, ...(body.code === undefined ? {} : { code: body.code }) });
      if (url.endsWith('/v1/auth/request-otp'))
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      return body.code === '123456'
        ? new Response(JSON.stringify({ data: { token: 'session-test-reprompt' } }), {
            status: 200,
          })
        : new Response(JSON.stringify({ error: { code: 'INVALID_CODE' } }), { status: 401 });
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runCli(['login', '--email', 'person@example.invalid']);

    expect(result).toBe(0);
    expect(calls.filter((call) => call.url.endsWith('/request-otp'))).toHaveLength(1);
    expect(
      calls.filter((call) => call.url.endsWith('/verify-otp')).map((call) => call.code),
    ).toEqual(['000000', '123456']);
    expect(JSON.stringify(errors.mock.calls)).toContain('The login code was invalid or expired.');
    expect(loadJoySession()?.token).toBe('session-test-reprompt');
  });

  it('stops after three wrong interactive codes', async () => {
    restorePrompts?.();
    restorePrompts = configureAuthPromptsForTests({
      interactive: () => true,
      code: async () => '000000',
    });
    let verifies = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/v1/auth/request-otp'))
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      verifies += 1;
      return new Response(JSON.stringify({ error: { code: 'INVALID_CODE' } }), { status: 401 });
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runCli(['login', '--email', 'person@example.invalid'])).toBe(1);
    expect(verifies).toBe(3);
  });

  it('shows identity and subscription details from the desktop identity endpoints as JSON', async () => {
    saveJoySession({
      token: 'tok-fake-1',
      email: 'person@example.invalid',
      apiOrigin: 'https://api.example.invalid',
    });
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
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    expect(keyring.has('joy-media-session')).toBe(false);
    fetchSpy.mockClear();
    expect(await runCli(['logout'])).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses authenticated calls when the saved login origin does not match', async () => {
    saveJoySession({ token: 'tok-fake-1', apiOrigin: 'https://joyst.ir' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runCli(['whoami', '--api-base', 'https://evil.example.invalid/api']);

    expect(result).not.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).toContain('saved login is for https://joyst.ir');
  });

  it('does not follow a cross-origin redirect for an authenticated request', async () => {
    saveJoySession({ token: 'tok-fake-1', apiOrigin: 'https://joyst.ir' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'https://evil.example.invalid/' } }),
      );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runCli(['whoami']);

    expect(result).not.toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toEqual({ authorization: 'Bearer tok-fake-1' });
    expect(JSON.stringify(errors.mock.calls)).not.toContain('https://evil.example.invalid');
  });

  it('times out server logout, clears the local token, and reports that revocation was not confirmed', async () => {
    saveJoySession({ token: 'tok-fake-1', apiOrigin: 'https://joyst.ir' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException('The operation was aborted', 'TimeoutError');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runCli(['logout'])).toBe(0);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(keyring.has('joy-media-session')).toBe(false);
    expect(JSON.stringify(errors.mock.calls)).toContain('Server logout could not be confirmed');
  });

  it('shows the stable too-many-attempts login message', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('/v1/auth/request-otp')
        ? new Response(JSON.stringify({ data: { message: 'Code requested.' } }), { status: 200 })
        : new Response(
            JSON.stringify({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'private detail' } }),
            { status: 429 },
          ),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(
      await runCli(['login', '--email', 'person@example.invalid', '--code', '123456']),
    ).not.toBe(0);

    expect(JSON.stringify(errors.mock.calls)).toContain('Too many incorrect login codes');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('private detail');
  });

  it('shows the stable rate-limited login message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'private detail' } }), {
        status: 429,
      }),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(
      await runCli(['login', '--email', 'person@example.invalid', '--code', '123456']),
    ).not.toBe(0);

    expect(JSON.stringify(errors.mock.calls)).toContain(
      'Too many login requests. Try again later.',
    );
    expect(JSON.stringify(errors.mock.calls)).not.toContain('private detail');
  });
});
