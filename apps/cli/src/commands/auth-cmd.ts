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
  /** Verify a code you already received; do not request a new one. */
  readonly codeOnly?: boolean;
  /** Only request a code (for scripts without a TTY); finish later with --code-only. */
  readonly requestCode?: boolean;
  readonly apiBase?: string;
  readonly insecureFileStore?: boolean;
  readonly json?: boolean;
}

interface AuthRequestError extends Error {
  readonly status?: number;
  readonly code?: string;
  /** Set when no HTTP response arrived (DNS, refused connection, TLS, timeout). */
  readonly network?: string;
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
          ? `Login failed: ${message || 'unexpected error'}.`
          : 'JOY account request failed.',
      );
    return 1;
  }
}

const LOGIN_CODE = /^\d{4,8}$/;
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_INTERACTIVE_CODE_ATTEMPTS = 3;

async function login(options: AuthCommandOptions): Promise<number> {
  // Validate everything that can fail locally before a code is requested: a request
  // sends a real email and uses up one of the account's few active codes.
  const apiBase = resolveLoginApiBase(options.apiBase);
  const interactive = prompts.interactive();
  if (options.email === undefined && !interactive)
    throw new AuthInputError('Pass --email when stdin is not an interactive TTY.');
  if (options.requestCode && (options.codeOnly || options.code !== undefined))
    throw new AuthInputError('--request-code cannot be combined with --code or --code-only.');
  if (options.code !== undefined && !LOGIN_CODE.test(options.code))
    throw new AuthInputError('Invalid code: login codes are 4 to 8 digits.');
  if (!options.requestCode && options.code === undefined && !interactive)
    throw new AuthInputError(
      options.codeOnly
        ? 'Pass --code with --code-only when stdin is not an interactive TTY.'
        : 'Pass --code when stdin is not an interactive TTY, or run with --request-code first and then --code-only --code <code>.',
    );
  if (!options.requestCode) {
    try {
      assertJoySessionStorable(Boolean(options.insecureFileStore));
    } catch {
      throw new AuthInputError(NO_LOGIN_KEYRING, 1);
    }
  }
  const email = (options.email ?? (await prompts.email())).trim();
  if (!EMAIL_ADDRESS.test(email)) throw new AuthInputError('Invalid email address.');
  if (!options.codeOnly) {
    try {
      await requestJson(`${apiBase}/v1/auth/request-otp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contact: email, method: 'gmail' }),
      });
    } catch (error) {
      logError(describeLoginFailure(error, 'request', apiBase));
      return 1;
    }
    if (options.requestCode) {
      logSuccess(`If ${email} can sign in, a login code is on its way.`);
      console.log(
        `Finish with: joy-media login --email ${email} --code-only${options.apiBase ? ` --api-base ${apiBase}` : ''}`,
      );
      return 0;
    }
  }
  // A typo in the interactive flow is re-prompted; it must not cost another email.
  const attempts = options.code === undefined ? MAX_INTERACTIVE_CODE_ATTEMPTS : 1;
  let verification: unknown;
  for (let attempt = 1; ; attempt += 1) {
    const code = options.code ?? (await prompts.code());
    if (!LOGIN_CODE.test(code)) {
      if (attempt < attempts) {
        logError('Invalid code: login codes are 4 to 8 digits.');
        continue;
      }
      throw new AuthInputError('Invalid code: login codes are 4 to 8 digits.');
    }
    try {
      verification = await requestJson(`${apiBase}/v1/auth/verify-otp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contact: email, method: 'gmail', code }),
      });
      break;
    } catch (error) {
      logError(describeLoginFailure(error, 'verify', apiBase));
      if (attempt >= attempts || !isRejectedCode(error)) return 1;
    }
  }
  const token =
    isRecord(verification) && typeof verification.token === 'string'
      ? verification.token
      : undefined;
  if (!token) {
    logError('The JOY server sent an unexpected login response. Try again later.');
    return 1;
  }
  saveJoySession(
    { token, email, apiOrigin: new URL(apiBase).origin },
    Boolean(options.insecureFileStore),
  );
  logSuccess(`Logged in as ${email}.`);
  return 0;
}

/** A wrong or expired code (not a lockout, rate limit, server or network failure). */
function isRejectedCode(error: unknown): boolean {
  const status = statusOf(error);
  const code = errorCodeOf(error);
  return (
    code !== 'TOO_MANY_ATTEMPTS' &&
    code !== 'RATE_LIMITED' &&
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 404 &&
    status !== 429
  );
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

const AUTH_REQUEST_TIMEOUT_MS = 20_000;

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    const error = new Error('JOY account request did not reach the server') as AuthRequestError;
    Object.defineProperty(error, 'network', { value: networkReason(cause) });
    throw error;
  }
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

/**
 * Names what went wrong with a login request. Only a rejected code keeps the deliberately
 * vague "invalid or expired" wording; the server hides whether the address exists.
 */
function describeLoginFailure(
  error: unknown,
  phase: 'request' | 'verify',
  apiBase: string,
): string {
  const origin = new URL(apiBase).origin;
  const network = isRecord(error) && typeof error.network === 'string' ? error.network : undefined;
  if (network)
    return `Could not reach the JOY API at ${origin} (${network}). Check --api-base and your connection.`;
  const code = errorCodeOf(error);
  if (code === 'TOO_MANY_ATTEMPTS')
    return 'Too many incorrect login codes. Request a new code later.';
  if (code === 'RATE_LIMITED') return 'Too many login requests. Try again later.';
  const status = statusOf(error) ?? 0;
  const action = phase === 'request' ? 'sending the login code' : 'checking the login code';
  if (status === 0 || (status >= 300 && status < 400))
    return `The JOY API at ${origin} answered with a redirect (HTTP ${status}); check --api-base (it should be the API URL, e.g. https://joyst.ir/api).`;
  if (status >= 500)
    return `The JOY server failed (HTTP ${status}) while ${action}. This is not a problem with your email; try again in a few minutes.`;
  if (status === 404) return `${apiBase} has no login endpoint (HTTP 404); check --api-base.`;
  if (status === 429) return 'Too many login requests. Try again later.';
  if (phase === 'verify') return 'The login code was invalid or expired.';
  return `The server rejected the login request (HTTP ${status}). Check the email address and try again.`;
}

function networkReason(cause: unknown): string {
  if (isRecord(cause) && (cause.name === 'TimeoutError' || cause.name === 'AbortError'))
    return `no answer within ${AUTH_REQUEST_TIMEOUT_MS / 1000} s`;
  const nested = isRecord(cause) && isRecord(cause.cause) ? cause.cause : undefined;
  const code = nested && typeof nested.code === 'string' ? nested.code : undefined;
  return code && /^[A-Z0-9_]{2,40}$/.test(code) ? code : 'network error';
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
