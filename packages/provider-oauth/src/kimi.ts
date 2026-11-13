import { isRecord } from './is-record.js';
import { getOAuthClient } from '@joy-media/provider-sdk';
import { OAuthFlowError } from './errors.js';
import {
  type FetchLike,
  parseReplyObject,
  replyText,
  type OAuthAuthorizationPresentation,
} from './http.js';

/** The public Kimi Code client comes from the provider SDK's OAuth client table. */
export const KIMI_CODE_CLIENT_ID = getOAuthClient('kimi')?.clientId ?? '';
/** International Kimi Code OAuth host confirmed by the owner. */
export const KIMI_CODE_OAUTH_HOST = 'https://auth.kimi.ai';
/** Kimi Code's OpenAI-compatible coding API. This is separate from Moonshot Platform's /v1 API. */
export const KIMI_CODE_BASE_URL = 'https://api.kimi.ai/coding/v1';
/** Kimi Code uses RFC 8628's device-code grant. */
export const KIMI_CODE_DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
/** Kimi Code's default device-code polling cadence is five seconds. */
export const KIMI_CODE_DEFAULT_POLL_INTERVAL_MS = 5_000;
/** Refresh starts when the access token has at most this much time left. */
export const KIMI_CODE_REFRESH_MARGIN_MS = 60_000;
/** No OAuth HTTP request is allowed to hang beyond this time. */
export const KIMI_CODE_REQUEST_TIMEOUT_MS = 30_000;
/** A device flow is bounded even if the server omits an expiry. */
const KIMI_CODE_MAX_DEVICE_WAIT_MS = 15 * 60_000;
const KIMI_CODE_DEFAULT_DEVICE_WAIT_MS = 5 * 60_000;
const KIMI_CODE_SCOPE = 'kimi-code';

/** The OAuth tokens and their metadata are one secret in the local provider profile. */
export interface KimiTokenRecord {
  readonly version: 1;
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: number;
  readonly scope: string;
}

export interface KimiCodeSignInOptions {
  /** Aborting cancels the sign-in: the polling stops and an in-flight request is aborted (T-J03). */
  readonly signal?: AbortSignal;
  /** The app-settings client override, or the public client from the provider SDK table. */
  readonly clientId?: string;
  /** Opens the verified Kimi Code device authorization page in the system browser. */
  readonly openExternal: (url: string) => void | Promise<void>;
  /** Injected so tests never reach Kimi. */
  readonly fetch: FetchLike;
  readonly now: () => number;
  /** Optional terminal presentation; desktop keeps using openExternal unchanged (D22 step 3 design §7). */
  readonly onAuthorization?: (presentation: OAuthAuthorizationPresentation) => void;
  /** Reports the first slow_down status without changing the provider's polling interval. */
  readonly onSlowDown?: () => void;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

export interface KimiTokenKeeperDeps {
  readonly fetch: FetchLike;
  readonly now: () => number;
  readonly save: (profileId: string, handleId: string, record: KimiTokenRecord) => Promise<void>;
  readonly marginMs?: number;
}

export interface KimiTokenKeeper {
  current(profileId: string, handleId: string, record: KimiTokenRecord): Promise<KimiTokenRecord>;
}

interface FormReply {
  readonly response: Response;
  readonly reply: Record<string, unknown> | undefined;
}

interface KimiDeviceCode {
  readonly userCode: string;
  readonly deviceCode: string;
  readonly approvalUrl: string;
  readonly expiresAt: number;
  readonly intervalMs: number;
}

/** Runs Kimi Code's attended device-code flow and returns a record for the local secret store. */
export async function signInWithKimiCode(options: KimiCodeSignInOptions): Promise<KimiTokenRecord> {
  throwIfCancelled(options.signal);
  const clientId = nonEmptyString(options.clientId) ?? KIMI_CODE_CLIENT_ID;
  if (clientId.length === 0) {
    throw new OAuthFlowError('NOT_CONFIGURED', 'Kimi sign-in needs an OAuth client ID.');
  }
  const requestedAt = options.now();
  const device = await requestDeviceCode(options, clientId);
  throwIfCancelled(options.signal);
  try {
    await options.openExternal(device.approvalUrl);
  } catch {
    if (isCancelled(options.signal)) throw cancelled();
    throw new OAuthFlowError('EXCHANGE_FAILED', 'Kimi approval page could not be opened.');
  }
  throwIfCancelled(options.signal);
  try {
    options.onAuthorization?.({
      url: device.approvalUrl,
      userCode: device.userCode,
      expiresAt: device.expiresAt,
    });
  } catch {
    // Terminal presentation is observational, so a local output error cannot change Kimi's polling flow (D22 step 3 design §7).
  }

  const configuredInterval = options.pollIntervalMs;
  let intervalMs = Math.max(
    1_000,
    device.intervalMs,
    typeof configuredInterval === 'number' && Number.isFinite(configuredInterval)
      ? configuredInterval
      : 0,
  );
  const configuredTimeout = options.timeoutMs;
  const flowTimeout =
    typeof configuredTimeout === 'number' && Number.isFinite(configuredTimeout)
      ? Math.min(KIMI_CODE_MAX_DEVICE_WAIT_MS, Math.max(0, configuredTimeout))
      : KIMI_CODE_MAX_DEVICE_WAIT_MS;
  const deadline = Math.min(device.expiresAt, requestedAt + flowTimeout);
  const endpoint = `${KIMI_CODE_OAUTH_HOST}/api/oauth/token`;
  let pollImmediately = true;
  let slowDownReported = false;

  while (true) {
    if (isCancelled(options.signal)) {
      throw new OAuthFlowError('CANCELLED', 'The sign-in was cancelled.');
    }
    const remaining = deadline - options.now();
    if (remaining <= 0) throw deviceTimeout();
    if (!pollImmediately) await wait(Math.min(intervalMs, remaining), options.signal);
    pollImmediately = false;
    const pollRemaining = deadline - options.now();
    if (pollRemaining < 1_000) throw deviceTimeout();

    let result: FormReply;
    try {
      result = await postForm(
        options.fetch,
        endpoint,
        new URLSearchParams({
          client_id: clientId,
          device_code: device.deviceCode,
          grant_type: KIMI_CODE_DEVICE_GRANT_TYPE,
        }),
        Math.min(KIMI_CODE_REQUEST_TIMEOUT_MS, pollRemaining),
        options.signal,
      );
    } catch (error) {
      if (isCancelled(options.signal)) {
        throw new OAuthFlowError('CANCELLED', 'The sign-in was cancelled.');
      }
      if (options.now() >= deadline) throw deviceTimeout();
      throw error;
    }
    if (options.now() >= deadline) throw deviceTimeout();
    const reply = result.reply;
    if (reply === undefined) {
      throw new OAuthFlowError('EXCHANGE_FAILED', 'Kimi returned an unreadable token reply.');
    }

    if (result.response.ok && typeof reply.access_token === 'string') {
      throwIfCancelled(options.signal);
      return tokenRecordFromReply(reply, clientId, options.now());
    }
    const error = nonEmptyString(reply.error);
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      if (!slowDownReported) {
        try {
          options.onSlowDown?.();
        } catch {
          // The status callback cannot alter the server's required slow_down polling interval (D22 step 3 design §7).
        }
      }
      slowDownReported = true;
      intervalMs += 5_000;
      continue;
    }
    if (error === 'expired_token' || error === 'expired_device_code') throw deviceTimeout();
    if (error === 'access_denied' || error === 'authorization_denied') {
      throw new OAuthFlowError('ACCESS_DENIED', 'Kimi sign-in was denied.');
    }
    throw new OAuthFlowError(
      'EXCHANGE_FAILED',
      `Kimi could not complete sign-in (HTTP ${result.response.status}).`,
    );
  }
}

/** Refreshes an expiring Kimi token and saves its complete replacement in one call. */
export async function refreshKimiCodeTokens(input: {
  readonly record: KimiTokenRecord;
  readonly fetch: FetchLike;
  readonly now: () => number;
  readonly save: (record: KimiTokenRecord) => Promise<void>;
}): Promise<KimiTokenRecord> {
  const result = await postForm(
    input.fetch,
    `${KIMI_CODE_OAUTH_HOST}/api/oauth/token`,
    new URLSearchParams({
      client_id: input.record.clientId,
      grant_type: 'refresh_token',
      refresh_token: input.record.refreshToken,
    }),
    KIMI_CODE_REQUEST_TIMEOUT_MS,
  );
  const reply = result.reply;
  if (reply === undefined) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'Kimi could not refresh this sign-in.');
  }
  const error = nonEmptyString(reply.error);
  if (
    error === 'invalid_grant' ||
    result.response.status === 401 ||
    result.response.status === 403
  ) {
    throw new OAuthFlowError('SIGN_IN_REQUIRED', 'Sign in with Kimi again.');
  }
  if (!result.response.ok || typeof reply.access_token !== 'string') {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'Kimi could not refresh this sign-in.');
  }

  const accessToken = nonEmptyString(reply.access_token);
  const refreshToken = nonEmptyString(reply.refresh_token) ?? input.record.refreshToken;
  const accessExpiresAt = tokenExpiry(reply.expires_in, input.now());
  if (accessToken === undefined || accessExpiresAt === undefined) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'Kimi returned an invalid refresh reply.');
  }
  const scope = nonEmptyString(reply.scope) ?? input.record.scope;
  if (!hasKimiCodeScope(scope)) {
    throw new OAuthFlowError('MISSING_SCOPE', 'Kimi did not renew the Kimi Code access.');
  }
  const refreshed: KimiTokenRecord = {
    ...input.record,
    accessToken,
    refreshToken,
    accessExpiresAt,
    scope,
  };
  await input.save(refreshed);
  return refreshed;
}

/** Shares one rotating refresh-token exchange between concurrent requests for the same profile. */
export function createKimiTokenKeeper(deps: KimiTokenKeeperDeps): KimiTokenKeeper {
  const marginMs = deps.marginMs ?? KIMI_CODE_REFRESH_MARGIN_MS;
  const refreshing = new Map<string, Promise<KimiTokenRecord>>();
  return {
    current(profileId, handleId, record) {
      if (record.accessExpiresAt - deps.now() > marginMs) return Promise.resolve(record);
      const inFlight = refreshing.get(profileId);
      if (inFlight !== undefined) return inFlight;
      const refresh = refreshKimiCodeTokens({
        record,
        fetch: deps.fetch,
        now: deps.now,
        save: (next) => deps.save(profileId, handleId, next),
      }).finally(() => refreshing.delete(profileId));
      refreshing.set(profileId, refresh);
      return refresh;
    },
  };
}

/** Stores the whole Kimi Code token record as the profile's one secret. */
export function encodeKimiTokenRecord(record: KimiTokenRecord): string {
  return JSON.stringify(record);
}

/** Reads a valid Kimi Code record, or returns undefined for a normal API key or malformed record. */
export function decodeKimiTokenRecord(text: string): KimiTokenRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== 1) return undefined;
  const clientId = nonEmptyString(parsed.clientId);
  const accessToken = nonEmptyString(parsed.accessToken);
  const refreshToken = nonEmptyString(parsed.refreshToken);
  const { accessExpiresAt, scope } = parsed;
  if (
    clientId === undefined ||
    accessToken === undefined ||
    refreshToken === undefined ||
    typeof accessExpiresAt !== 'number' ||
    !Number.isFinite(accessExpiresAt) ||
    !hasKimiCodeScope(scope)
  ) {
    return undefined;
  }
  return {
    version: 1,
    clientId,
    accessToken,
    refreshToken,
    accessExpiresAt,
    scope,
  };
}

async function requestDeviceCode(
  options: KimiCodeSignInOptions,
  clientId: string,
): Promise<KimiDeviceCode> {
  const requestedAt = options.now();
  const result = await postForm(
    options.fetch,
    `${KIMI_CODE_OAUTH_HOST}/api/oauth/device_authorization`,
    new URLSearchParams({ client_id: clientId }),
    KIMI_CODE_REQUEST_TIMEOUT_MS,
    options.signal,
  );
  if (!result.response.ok || result.reply === undefined) {
    throw new OAuthFlowError(
      'EXCHANGE_FAILED',
      `Kimi did not issue a device code (HTTP ${result.response.status}).`,
    );
  }
  const userCode = nonEmptyString(result.reply.user_code);
  const deviceCode = nonEmptyString(result.reply.device_code);
  const verificationUri =
    nonEmptyString(result.reply.verification_uri_complete) ??
    nonEmptyString(result.reply.verification_uri);
  if (userCode === undefined || deviceCode === undefined || verificationUri === undefined) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'Kimi returned an incomplete device-code reply.');
  }
  const expiresInSeconds = positiveNumber(result.reply.expires_in);
  const expiresAt =
    requestedAt +
    Math.min(
      KIMI_CODE_MAX_DEVICE_WAIT_MS,
      (expiresInSeconds ?? KIMI_CODE_DEFAULT_DEVICE_WAIT_MS / 1000) * 1000,
    );
  if (expiresAt <= options.now()) throw deviceTimeout();
  const intervalSeconds =
    positiveNumber(result.reply.interval) ?? KIMI_CODE_DEFAULT_POLL_INTERVAL_MS / 1000;
  return {
    userCode,
    deviceCode,
    approvalUrl: approvalUrlFor(verificationUri, userCode),
    expiresAt,
    intervalMs: Math.max(1_000, Math.ceil(intervalSeconds * 1000)),
  };
}

function approvalUrlFor(verificationUri: string, userCode: string): string {
  let url: URL;
  try {
    url = new URL(verificationUri);
  } catch {
    throw new OAuthFlowError('REDIRECT_REFUSED', 'Kimi returned an untrusted approval page.');
  }
  const approvedHosts = new Set(['kimi.ai', 'www.kimi.ai']);
  const existingCode = url.searchParams.get('user_code');
  if (
    url.protocol !== 'https:' ||
    !approvedHosts.has(url.hostname) ||
    url.pathname !== '/code/authorize_device' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    (existingCode !== null && existingCode !== userCode)
  ) {
    throw new OAuthFlowError('REDIRECT_REFUSED', 'Kimi returned an untrusted approval page.');
  }
  url.searchParams.set('user_code', userCode);
  return url.toString();
}

async function postForm(
  fetch: FetchLike,
  endpoint: string,
  body: URLSearchParams,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<FormReply> {
  throwIfCancelled(signal);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // A cancelled sign-in stops the request in flight too (T-J03).
  const onCancel = (): void => controller.abort();
  signal?.addEventListener('abort', onCancel, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'x-msh-platform': 'joy_media',
        },
        body: body.toString(),
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      if (isCancelled(signal)) throw cancelled();
      throw new OAuthFlowError('EXCHANGE_FAILED', 'Kimi could not be reached.');
    }
    throwIfCancelled(signal);
    try {
      const reply = parseReplyObject(await replyText(response));
      throwIfCancelled(signal);
      return { response, reply };
    } catch (error) {
      if (isCancelled(signal)) throw cancelled();
      throw error;
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCancel);
  }
}

function tokenRecordFromReply(
  reply: Record<string, unknown>,
  clientId: string,
  now: number,
): KimiTokenRecord {
  const accessToken = nonEmptyString(reply.access_token);
  const refreshToken = nonEmptyString(reply.refresh_token);
  const expiresIn = tokenExpiry(reply.expires_in, now);
  const scope = nonEmptyString(reply.scope);
  if (accessToken === undefined || refreshToken === undefined || expiresIn === undefined) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'Kimi returned an invalid token reply.');
  }
  if (scope === undefined || !hasKimiCodeScope(scope)) {
    throw new OAuthFlowError('MISSING_SCOPE', 'Kimi did not grant Kimi Code access.');
  }
  return {
    version: 1,
    clientId,
    accessToken,
    refreshToken,
    accessExpiresAt: expiresIn,
    scope,
  };
}

function tokenExpiry(value: unknown, now: number): number | undefined {
  const seconds = positiveNumber(value);
  return seconds === undefined ? undefined : now + seconds * 1000;
}

function positiveNumber(value: unknown): number | undefined {
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function hasKimiCodeScope(value: unknown): value is string {
  return typeof value === 'string' && value.split(/\s+/).includes(KIMI_CODE_SCOPE);
}

function deviceTimeout(): OAuthFlowError {
  return new OAuthFlowError('TIMEOUT', 'Kimi device authorization timed out.');
}

/** True once a cancelled sign-in has aborted its signal (T-J03). */
function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function cancelled(): OAuthFlowError {
  return new OAuthFlowError('CANCELLED', 'The sign-in was cancelled.');
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (isCancelled(signal)) throw cancelled();
}

/** Waits, or rejects with CANCELLED as soon as the signal aborts (T-J03). */
function wait(durationMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new OAuthFlowError('CANCELLED', 'The sign-in was cancelled.'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new OAuthFlowError('CANCELLED', 'The sign-in was cancelled.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
