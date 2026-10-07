/* global console, process */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  assertJoySessionStorable,
  clearJoySession,
  loadJoySession,
  saveJoySession,
} from '../utils/config.js';
import { logError, logSuccess } from '../utils/logger.js';

export interface AuthCommandOptions {
  readonly email?: string;
  readonly code?: string;
  readonly apiBase?: string;
  readonly insecureFileStore?: boolean;
  readonly json?: boolean;
}

interface AuthRequestError extends Error {
  readonly status?: number;
  readonly code?: string;
}

const DEFAULT_JOY_API_BASE = 'https://joyst.ir/api';

/** A problem with the user's own flags or setup, found before any request (exit 2). */
class AuthInputError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'AuthInputError';
    this.exitCode = exitCode;
  }
}

const NO_LOGIN_KEYRING =
  'No usable system keyring is available to store the login. Re-run with --insecure-file-store to keep the session token in a private (0600) file instead.';

/** Terminal interaction, replaceable in tests so a developer TTY never blocks a run. */
export interface AuthPrompts {
  readonly interactive: () => boolean;
  readonly email: () => Promise<string>;
  readonly code: () => Promise<string>;
}

const defaultPrompts: AuthPrompts = {
  interactive: () => Boolean(stdin.isTTY) && typeof stdin.setRawMode === 'function',
  email: () => promptEmail(),
  code: () => promptHiddenCode(),
};
let prompts: AuthPrompts = defaultPrompts;

export function configureAuthPromptsForTests(next: Partial<AuthPrompts>): () => void {
  const previous = prompts;
  prompts = { ...defaultPrompts, ...next };
  return () => {
    prompts = previous;
  };
}

export async function handleAuthCommand(
  args: readonly string[],
  options: AuthCommandOptions = {},
): Promise<number> {
  const [command] = args;
  try {
    if (command === 'login') return await login(options);
    if (command === 'logout') return await logout(options);
    if (command === 'whoami') return await whoami(options);
    logError('Usage: joy-media <login|logout|whoami> [options]');
    return 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = errorCodeOf(error);
    if (error instanceof AuthInputError) {
      logError(message);
      return error.exitCode;
    }
    if (
      message.startsWith('No usable system keyring is available.') ||
      message.startsWith('saved login is for ')
    )
      logError(message);
    else if (code === 'TOO_MANY_ATTEMPTS')
      logError('Too many incorrect login codes. Request a new code later.');
    else if (code === 'RATE_LIMITED') logError('Too many login requests. Try again later.');
    else
      logError(
        command === 'login'
          ? 'Login failed. Check the email and try again.'
          : 'JOY account request failed.',
      );
    return 1;
  }
}

const LOGIN_CODE = /^\d{4,8}$/;
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function login(options: AuthCommandOptions): Promise<number> {
  // Validate everything that can fail locally before a code is requested: a request
  // sends a real email and uses up one of the account's few active codes.
  const apiBase = resolveLoginApiBase(options.apiBase);
  const interactive = prompts.interactive();
  if (options.email === undefined && !interactive)
    throw new AuthInputError('Pass --email when stdin is not an interactive TTY.');
  if (options.code !== undefined && !LOGIN_CODE.test(options.code))
    throw new AuthInputError('Invalid code: login codes are 4 to 8 digits.');
  if (options.code === undefined && !interactive)
    throw new AuthInputError('Pass --code when stdin is not an interactive TTY.');
  try {
    assertJoySessionStorable(Boolean(options.insecureFileStore));
  } catch {
    throw new AuthInputError(NO_LOGIN_KEYRING, 1);
  }
  const email = (options.email ?? (await prompts.email())).trim();
  if (!EMAIL_ADDRESS.test(email)) throw new AuthInputError('Invalid email address.');
  await requestJson(`${apiBase}/v1/auth/request-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contact: email, method: 'gmail' }),
  });
  const code = options.code ?? (await prompts.code());
  if (!LOGIN_CODE.test(code))
    throw new AuthInputError('Invalid code: login codes are 4 to 8 digits.');
  let verification: unknown;
  try {
    verification = await requestJson(`${apiBase}/v1/auth/verify-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contact: email, method: 'gmail', code }),
    });
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === 'TOO_MANY_ATTEMPTS')
      logError('Too many incorrect login codes. Request a new code later.');
    else if (code === 'RATE_LIMITED') logError('Too many login requests. Try again later.');
    else logError('The login code was invalid or expired.');
    return 1;
  }
  const token =
    isRecord(verification) && typeof verification.token === 'string'
      ? verification.token
      : undefined;
  if (!token) throw new Error('Invalid login response');
  saveJoySession(
    { token, email, apiOrigin: new URL(apiBase).origin },
    Boolean(options.insecureFileStore),
  );
  logSuccess(`Logged in as ${email}.`);
  return 0;
}

async function whoami(options: AuthCommandOptions): Promise<number> {
  const session = loadJoySession();
  if (!session) return signedOut(options.json);
  const apiBase = resolveApiBase(options.apiBase);
  assertSessionOrigin(session.apiOrigin ?? 'https://joyst.ir', apiBase);
  let identity: unknown;
  try {
    identity = await requestJson(`${apiBase}/v1/auth/session`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
  } catch (error) {
    if (statusOf(error) === 401) {
      clearJoySession();
      return signedOut(options.json);
    }
    throw error;
  }
  const contact =
    isRecord(identity) && typeof identity.contact === 'string' ? identity.contact : session.email;
  if (!contact) throw new Error('Identity response is invalid');
  let subscription: unknown;
  try {
    subscription = await requestJson(`${apiBase}/v1/account/subscription`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
  } catch (error) {
    if (statusOf(error) === 401) {
      clearJoySession();
      return signedOut(options.json);
    }
    throw error;
  }
  const data = isRecord(subscription) ? subscription : {};
  const result = {
    email: contact,
    plan: typeof data.plan === 'string' ? data.plan : 'unknown',
    subscriptionStatus: typeof data.status === 'string' ? data.status : 'unknown',
  };
  if (options.json) console.log(JSON.stringify(result));
  else console.log(`${result.email} · ${result.plan} (${result.subscriptionStatus})`);
  return 0;
}

async function logout(options: AuthCommandOptions): Promise<number> {
  const session = loadJoySession();
  if (!session) {
    logSuccess('Already logged out.');
    return 0;
  }
  try {
    const apiBase = resolveApiBase(options.apiBase);
    assertSessionOrigin(session.apiOrigin ?? 'https://joyst.ir', apiBase);
    const response = await fetch(`${apiBase}/v1/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Server logout was not confirmed');
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    logError(
      message.startsWith('saved login is for ')
        ? message
        : 'Server logout could not be confirmed; the local session was removed.',
    );
  } finally {
    clearJoySession();
  }
  logSuccess('Logged out.');
  return 0;
}

function signedOut(json = false): number {
  if (json) console.log(JSON.stringify({ error: 'Not logged in', hint: 'Run joy-media login.' }));
  else logError('Not logged in. Run joy-media login.');
  return 1;
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: 'manual' });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const code = isRecord(body) && isRecord(body.error) ? body.error.code : undefined;
    const error = new Error('JOY account request failed') as AuthRequestError;
    Object.defineProperty(error, 'status', { value: response.status });
    if (typeof code === 'string') Object.defineProperty(error, 'code', { value: code });
    throw error;
  }
  return isRecord(body) ? body.data : undefined;
}

function assertSessionOrigin(savedOrigin: string, apiBase: string): void {
  const normalizedSavedOrigin = new URL(savedOrigin).origin;
  if (new URL(apiBase).origin !== normalizedSavedOrigin) {
    throw new Error(
      `saved login is for ${normalizedSavedOrigin}; run joy-media login --api-base <url> for this host`,
    );
  }
}

function resolveApiBase(flag?: string): string {
  const raw =
    flag ??
    (process.env.JOY_MEDIA_API_BASE_URL || process.env.JOY_MEDIA_API_URL || DEFAULT_JOY_API_BASE);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid API base URL');
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('API base URL must use HTTPS or localhost HTTP');
  return url.toString().replace(/\/+$/, '');
}

function resolveLoginApiBase(flag?: string): string {
  try {
    return resolveApiBase(flag);
  } catch (error) {
    throw new AuthInputError(error instanceof Error ? error.message : 'Invalid API base URL');
  }
}

function statusOf(error: unknown): number | undefined {
  return isRecord(error) && typeof error.status === 'number' ? error.status : undefined;
}

function errorCodeOf(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

async function promptEmail(): Promise<string> {
  if (!stdin.isTTY) throw new Error('Pass --email when stdin is not a TTY');
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return await prompt.question('Email: ');
  } finally {
    prompt.close();
  }
}

async function promptHiddenCode(): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function')
    throw new Error('Pass --code when stdin is not an interactive TTY');
  stdout.write('Code: ');
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdout.write('\n');
    };
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Login cancelled'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (/\d/.test(char) && value.length < 8) value += char;
      }
    };
    stdin.on('data', onData);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
