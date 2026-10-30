import { getOAuthClient, XAI_OAUTH_INFERENCE_BASE_URL } from '@joy-media/provider-sdk';
import { OAuthFlowError } from './errors.js';
import { type FetchLike, parseReplyObject, replyText } from './http.js';

/** The xAI OIDC issuer and discovery location named by the Grok Build authentication guide. */
export const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
/** The public Grok CLI OAuth client; JOY's app setting can replace this default. */
export const XAI_OAUTH_CLIENT_ID = getOAuthClient('xai')?.clientId ?? '';
/** The scopes used by the public Grok CLI device flow (Grok Build authentication guide). */
export const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
/** The device grant advertised by xAI's OIDC discovery document and used by the Grok CLI flow. */
export const XAI_OAUTH_DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
/** The single candidate inference base in the provider registry; it still needs attended verification. */
export { XAI_OAUTH_INFERENCE_BASE_URL };
/** Refresh begins when the access token has at most this much time left, matching the neighboring OAuth keepers. */
export const XAI_OAUTH_REFRESH_MARGIN_MS = 60_000;
/** No OAuth HTTP request is allowed to hang beyond this time. */
export const XAI_OAUTH_REQUEST_TIMEOUT_MS = 30_000;
/** Device authorization is bounded even if xAI omits an expiry. */
const XAI_OAUTH_MAX_DEVICE_WAIT_MS = 15 * 60_000;
const XAI_OAUTH_DEFAULT_DEVICE_WAIT_MS = 5 * 60_000;
const XAI_OAUTH_DEFAULT_POLL_INTERVAL_MS = 5_000;

/** xAI OAuth tokens and their metadata are kept together as one profile secret. */
export interface XaiTokenRecord {
  readonly version: 1;
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: number;
  readonly scope: string;
}

export interface XaiSignInOptions {
  /** JOY's configured public client ID, or the Grok CLI public default. */
  readonly clientId?: string;
  /** Opens the validated xAI device-approval URL in the system browser. */
  readonly openExternal: (url: string) => void | Promise<void>;
  /** Injected so tests never reach xAI. */
  readonly fetch: FetchLike;
  readonly now: () => number;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

export interface XaiTokenKeeperDeps {
  readonly fetch: FetchLike;
  readonly now: () => number;
  readonly save: (profileId: string, handleId: string, record: XaiTokenRecord) => Promise<void>;
  readonly marginMs?: number;
}

export interface XaiTokenKeeper {
  current(
    profileId: string,
    handleId: string,
    record: XaiTokenRecord,
  ): Promise<XaiTokenRecord>;
}

interface FormReply {
  readonly response: Response;
  readonly reply: Record<string, unknown> | undefined;
}

interface XaiDeviceCode {
  readonly userCode: string;
  readonly deviceCode: string;
  readonly approvalUrl: string;
  readonly expiresAt: number;
  readonly intervalMs: number;
}

interface XaiEndpoints {
  readonly deviceAuthorizationEndpoint: string;
  readonly tokenEndpoint: string;
}

/** Runs xAI's attended OIDC device-code flow and returns a record for the local secret store. */
export async function signInWithXai(options: XaiSignInOptions): Promise<XaiTokenRecord> {
  const requestedAt = options.now();
  const clientId = nonEmptyString(options.clientId) ?? XAI_OAUTH_CLIENT_ID;
  if (clientId.length === 0) {
    throw new OAuthFlowError('NOT_CONFIGURED', 'xAI sign-in needs an OAuth client ID.');
  }
  const endpoints = await discoverEndpoints(options.fetch);
  const device = await requestDeviceCode(options, clientId, endpoints);
  try {
    await options.openExternal(device.approvalUrl);
  } catch {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'xAI approval page could not be opened.');
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
      ? Math.min(XAI_OAUTH_MAX_DEVICE_WAIT_MS, Math.max(0, configuredTimeout))
      : XAI_OAUTH_MAX_DEVICE_WAIT_MS;
  const deadline = Math.min(device.expiresAt, requestedAt + flowTimeout);
  let pollImmediately = true;

  while (true) {
    const remaining = deadline - options.now();
    if (remaining <= 0) throw deviceTimeout();
    if (!pollImmediately) await wait(Math.min(intervalMs, remaining));
    pollImmediately = false;
    const pollRemaining = deadline - options.now();
    if (pollRemaining < 1_000) throw deviceTimeout();

    let result: FormReply;
    try {
      result = await postForm(
        options.fetch,
        endpoints.tokenEndpoint,
        new URLSearchParams({
          client_id: clientId,
          device_code: device.deviceCode,
          grant_type: XAI_OAUTH_DEVICE_GRANT_TYPE,
        }),
        Math.min(XAI_OAUTH_REQUEST_TIMEOUT_MS, pollRemaining),
      );
    } catch (error) {
      if (options.now() >= deadline) throw deviceTimeout();
      throw error;
    }
    if (options.now() >= deadline) throw deviceTimeout();
    const reply = result.reply;
    if (reply === undefined) {
      throw new OAuthFlowError('EXCHANGE_FAILED', 'xAI returned an unreadable token reply.');
    }

    if (result.response.ok && typeof reply.access_token === 'string') {
      return tokenRecordFromReply(reply, clientId, options.now());
    }
    const error = nonEmptyString(reply.error);
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      intervalMs += 5_000;
      continue;
    }
    if (error === 'expired_token' || error === 'expired_device_code') throw deviceTimeout();
    if (error === 'access_denied' || error === 'authorization_denied') {
      throw new OAuthFlowError('ACCESS_DENIED', 'xAI sign-in was denied.');
    }
    throw new OAuthFlowError(
      'EXCHANGE_FAILED',
      `xAI could not complete sign-in (HTTP ${result.response.status}).`,
    );
  }
}

/** Refreshes an expiring xAI token and saves its complete replacement in one call. */
export async function refreshXaiTokens(input: {
  readonly record: XaiTokenRecord;
  readonly fetch: FetchLike;
  readonly now: () => number;
  readonly save: (record: XaiTokenRecord) => Promise<void>;
}): Promise<XaiTokenRecord> {
  const endpoints = await discoverEndpoints(input.fetch);
  const result = await postForm(
    input.fetch,
    endpoints.tokenEndpoint,
    new URLSearchParams({
      client_id: input.record.clientId,
      grant_type: 'refresh_token',
      refresh_token: input.record.refreshToken,
    }),
    XAI_OAUTH_REQUEST_TIMEOUT_MS,
  );
  const reply = result.reply;
  if (reply === undefined) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'xAI could not refresh this sign-in.');
  }
  const error = nonEmptyString(reply.error);
  if (error === 'invalid_grant' || result.response.status === 401 || result.response.status === 403) {
    throw new OAuthFlowError('SIGN_IN_REQUIRED', 'Sign in with xAI again.');
  }
  if (!result.response.ok || typeof reply.access_token !== 'string') {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'xAI could not refresh this sign-in.');
  }

  const accessToken = nonEmptyString(reply.access_token);
  const refreshToken = nonEmptyString(reply.refresh_token) ?? input.record.refreshToken;
  const accessExpiresAt = tokenExpiry(reply.expires_in, input.now());
  if (accessToken === undefined || accessExpiresAt === undefined) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'xAI returned an invalid refresh reply.');
  }
  const scope = nonEmptyString(reply.scope) ?? input.record.scope;
  if (!hasApiAccessScope(scope)) {
    throw new OAuthFlowError('MISSING_SCOPE', 'xAI did not renew API access.');
  }
  const refreshed: XaiTokenRecord = {
    ...input.record,
    accessToken,
    refreshToken,
    accessExpiresAt,
    scope,
  };
  await input.save(refreshed);
  return refreshed;
}

/** Shares a rotating refresh-token exchange between concurrent requests for the same profile. */
export function createXaiTokenKeeper(deps: XaiTokenKeeperDeps): XaiTokenKeeper {
  const marginMs = deps.marginMs ?? XAI_OAUTH_REFRESH_MARGIN_MS;
  const refreshing = new Map<string, Promise<XaiTokenRecord>>();
  return {
    current(profileId, handleId, record) {
      if (record.accessExpiresAt - deps.now() > marginMs) return Promise.resolve(record);
      const inFlight = refreshing.get(profileId);
      if (inFlight !== undefined) return inFlight;
      const refresh = refreshXaiTokens({
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

/** Stores the whole xAI token record as the profile's one secret. */
export function encodeXaiTokenRecord(record: XaiTokenRecord): string {
  return JSON.stringify(record);
}

/** Reads a valid xAI record, or returns undefined for a normal API key or malformed record. */
export function decodeXaiTokenRecord(text: string): XaiTokenRecord | undefined {
  const parsed = parseReplyObject(text);
  if (parsed === undefined || parsed.version !== 1) return undefined;
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
    !hasApiAccessScope(scope)
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

async function discoverEndpoints(fetch: FetchLike): Promise<XaiEndpoints> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), XAI_OAUTH_REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      throw new OAuthFlowError('EXCHANGE_FAILED', 'xAI authorization service could not be reached.');
    }
    const reply = parseReplyObject(await replyText(response));
    if (!response.ok || reply === undefined) {
      throw new OAuthFlowError('EXCHANGE_FAILED', 'xAI returned an unreadable discovery reply.');
    }
    if (reply.issuer !== XAI_OAUTH_ISSUER) {
      throw new OAuthFlowError('REDIRECT_REFUSED', 'xAI returned an untrusted authorization issuer.');
    }
    const deviceAuthorizationEndpoint = trustedXaiEndpoint(reply.device_authorization_endpoint);
    const tokenEndpoint = trustedXaiEndpoint(reply.token_endpoint);
    return { deviceAuthorizationEndpoint, tokenEndpoint };
  } finally {
    clearTimeout(timer);
  }
}

async function requestDeviceCode(
  options: XaiSignInOptions,
  clientId: string,
  endpoints: XaiEndpoints,
): Promise<XaiDeviceCode> {
  const requestedAt = options.now();
  const result = await postForm(
    options.fetch,
    endpoints.deviceAuthorizationEndpoint,
    new URLSearchParams({ client_id: clientId, scope: XAI_OAUTH_SCOPE }),
    XAI_OAUTH_REQUEST_TIMEOUT_MS,
  );
  if (!result.response.ok || result.reply === undefined) {
    throw new OAuthFlowError(
      'EXCHANGE_FAILED',
      `xAI did not issue a device code (HTTP ${result.response.status}).`,
    );
  }
  const userCode = nonEmptyString(result.reply.user_code);
  const deviceCode = nonEmptyString(result.reply.device_code);
  const verificationUri =
    nonEmptyString(result.reply.verification_uri_complete) ??
    nonEmptyString(result.reply.verification_uri);
  if (userCode === undefined || deviceCode === undefined || verificationUri === undefined) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'xAI returned an incomplete device-code reply.');
  }
  const approvalUrl = approvalUrlFor(verificationUri, userCode);
  const expiresInSeconds = positiveNumber(result.reply.expires_in);
  const expiresAt =
    requestedAt +
    Math.min(
      XAI_OAUTH_MAX_DEVICE_WAIT_MS,
      (expiresInSeconds ?? XAI_OAUTH_DEFAULT_DEVICE_WAIT_MS / 1000) * 1000,
    );
  if (expiresAt <= options.now()) throw deviceTimeout();
  const intervalSeconds =
    positiveNumber(result.reply.interval) ?? XAI_OAUTH_DEFAULT_POLL_INTERVAL_MS / 1000;
  return {
    userCode,
    deviceCode,
    approvalUrl,
    expiresAt,
    intervalMs: Math.max(1_000, Math.ceil(intervalSeconds * 1000)),
  };
}

function approvalUrlFor(verificationUri: string, userCode: string): string {
  let url: URL;
  try {
    url = new URL(verificationUri);
  } catch {
    throw new OAuthFlowError('REDIRECT_REFUSED', 'xAI returned an untrusted approval page.');
  }
  const existingCode = url.searchParams.get('user_code');
  if (
    !isTrustedXaiUrl(url, true) ||
    url.hash !== '' ||
    (existingCode !== null && existingCode !== userCode)
  ) {
    throw new OAuthFlowError('REDIRECT_REFUSED', 'xAI returned an untrusted approval page.');
  }
  url.searchParams.set('user_code', userCode);
  return url.toString();
}

function trustedXaiEndpoint(value: unknown): string {
  if (typeof value !== 'string') {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'xAI discovery omitted a required endpoint.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthFlowError('REDIRECT_REFUSED', 'xAI returned an untrusted authorization endpoint.');
  }
  if (!isTrustedXaiUrl(url, false)) {
    throw new OAuthFlowError('REDIRECT_REFUSED', 'xAI returned an untrusted authorization endpoint.');
  }
  return url.toString();
}

function isTrustedXaiUrl(url: URL, allowQuery: boolean): boolean {
  const hostname = url.hostname.toLowerCase();
  return (
    url.protocol === 'https:' &&
    (hostname === 'x.ai' || hostname.endsWith('.x.ai')) &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    (allowQuery || url.search === '')
  );
}

async function postForm(
  fetch: FetchLike,
  endpoint: string,
  body: URLSearchParams,
  timeoutMs: number,
): Promise<FormReply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      throw new OAuthFlowError('EXCHANGE_FAILED', 'xAI authorization service could not be reached.');
    }
    return { response, reply: parseReplyObject(await replyText(response)) };
  } finally {
    clearTimeout(timer);
  }
}

function tokenRecordFromReply(
  reply: Record<string, unknown>,
  clientId: string,
  now: number,
): XaiTokenRecord {
  const accessToken = nonEmptyString(reply.access_token);
  const refreshToken = nonEmptyString(reply.refresh_token);
  const accessExpiresAt = tokenExpiry(reply.expires_in, now);
  const scope = nonEmptyString(reply.scope) ?? XAI_OAUTH_SCOPE;
  if (accessToken === undefined || refreshToken === undefined || accessExpiresAt === undefined) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'xAI returned an invalid token reply.');
  }
  if (!hasApiAccessScope(scope)) {
    throw new OAuthFlowError('MISSING_SCOPE', 'xAI did not grant API access.');
  }
  return { version: 1, clientId, accessToken, refreshToken, accessExpiresAt, scope };
}

function tokenExpiry(value: unknown, now: number): number | undefined {
  const seconds = positiveNumber(value);
  return seconds === undefined ? undefined : now + seconds * 1000;
}

function positiveNumber(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function hasApiAccessScope(value: unknown): value is string {
  return typeof value === 'string' && value.split(/\s+/).includes('api:access');
}

function deviceTimeout(): OAuthFlowError {
  return new OAuthFlowError('TIMEOUT', 'xAI device authorization timed out.');
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
