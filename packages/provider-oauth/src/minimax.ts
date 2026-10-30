import {
  MINIMAX_OAUTH_ENDPOINTS,
  MINIMAX_OAUTH_SCOPE,
  type MiniMaxRegion,
} from '@joy-media/provider-sdk';
import { isRecord } from './is-record.js';
import { OAuthFlowError } from './errors.js';
import {
  type FetchLike,
  parseReplyObject,
  replyText,
  type OAuthAuthorizationPresentation,
} from './http.js';
import { createPkcePair, randomToken } from './pkce.js';

/** The MiniMax device-code scope (PLAN-v4 §6d). */
export const MINIMAX_SCOPE = MINIMAX_OAUTH_SCOPE;
/** MiniMax's RFC 8628 token grant for a device user code. */
export const MINIMAX_TOKEN_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:user_code';
/** The default poll interval, and the fastest this app polls (PLAN-v4 §6d). */
export const MINIMAX_POLL_INTERVAL_MS = 2_000;
/** Refresh starts when the access token has at most this much time left. */
export const MINIMAX_ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;
/** The longest one MiniMax request may take before it is given up on, so a stalled request cannot outlive the flow. */
export const MINIMAX_REQUEST_TIMEOUT_MS = 30_000;
/** Values below this are relative expiry durations in seconds. */
const MINIMAX_RELATIVE_EXPIRY_SECONDS_THRESHOLD = 1_000_000_000;
/** Values below this after the relative-duration threshold are absolute epoch seconds. */
const MINIMAX_ABSOLUTE_EXPIRY_MS_THRESHOLD = 1_000_000_000_000;

/**
 * MiniMax also documents an Anthropic Messages OAuth endpoint for each region (PLAN-v4 §6d). It is not implemented
 * here because the registry models one API kind per provider row, and MiniMax's M Plan credential works with the
 * OpenAI-compatible base the registry already carries. The origins live in the provider SDK, so this file names no
 * remote host itself.
 */

/**
 * The MiniMax OAuth token. The complete record is one secret, so a refresh writes the whole record in one call.
 */
export interface MiniMaxTokenRecord {
  readonly version: 1;
  /** JOY Media's own registered client ID. */
  readonly clientId: string;
  readonly region: MiniMaxRegion;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch milliseconds at which the access token expires. */
  readonly accessExpiresAt: number;
  /** The resource URL MiniMax returned with the token, when it returned one. */
  readonly resourceUrl?: string;
}

/** Inputs for an attended MiniMax device-code sign-in. */
export interface MiniMaxSignInOptions {
  /** JOY Media's own registered client ID; sign-in is unavailable until the owner registers it. */
  readonly clientId: string;
  /** The account and inference region selected by the owner (S5). */
  readonly region: MiniMaxRegion;
  /** Opens the returned verification URI in the system browser. */
  readonly openExternal: (url: string) => void | Promise<void>;
  /** Injected so tests never reach a provider. */
  readonly fetch: FetchLike;
  readonly now: () => number;
  /** Optional terminal presentation; desktop keeps using openExternal unchanged (D22 step 3 design §7). */
  readonly onAuthorization?: (presentation: OAuthAuthorizationPresentation) => void;
  /** Raises the minimum polling interval when supplied. */
  readonly pollIntervalMs?: number;
  /** Caps the device code's own expiry deadline when supplied. */
  readonly timeoutMs?: number;
}

/** Saves a refreshed MiniMax record under the same handle that started the refresh. */
export interface MiniMaxTokenKeeperDeps {
  readonly fetch: FetchLike;
  readonly now: () => number;
  readonly save: (profileId: string, handleId: string, record: MiniMaxTokenRecord) => Promise<void>;
  readonly marginMs?: number;
}

/** A keeper refreshes a profile's token record only when it is close to expiry. */
export interface MiniMaxTokenKeeper {
  current(
    profileId: string,
    handleId: string,
    record: MiniMaxTokenRecord,
  ): Promise<MiniMaxTokenRecord>;
}

/** A device code and everything needed to redeem it. The verifier and the state never leave the app. */
export interface MiniMaxDeviceCode {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAtMs: number;
  readonly intervalMs: number;
  /** The PKCE verifier that redeems this code. */
  readonly codeVerifier: string;
  /** The state sent with the request; the server echoes it and it must match. */
  readonly state: string;
}

interface FormReply {
  readonly response: Response;
  readonly reply: Record<string, unknown> | undefined;
}

/**
 * Requests one MiniMax device code, returning only the values needed to present it. The internal PKCE verifier stays
 * with the sign-in flow and is never returned to the renderer.
 */
export async function requestMiniMaxDeviceCode(
  input: Pick<MiniMaxSignInOptions, 'clientId' | 'region' | 'fetch' | 'now'>,
): Promise<MiniMaxDeviceCode> {
  assertClientId(input.clientId);
  const state = randomToken();
  const pkce = createPkcePair();
  const requested = await requestDeviceCode(input, state, pkce.challenge, pkce.verifier);
  return { ...requested, state };
}

/** Runs the attended device-code flow and returns the record to keep as one secret. */
export async function signInWithMiniMax(
  options: MiniMaxSignInOptions,
): Promise<MiniMaxTokenRecord> {
  assertClientId(options.clientId);
  const requestedAt = options.now();
  const deviceCode = await requestMiniMaxDeviceCode(options);
  const approvalUrl = approvalUrlFor(deviceCode.verificationUri, deviceCode.userCode);
  try {
    await options.openExternal(approvalUrl);
  } catch {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'MiniMax approval page could not be opened.');
  }
  try {
    options.onAuthorization?.({
      url: approvalUrl,
      userCode: deviceCode.userCode,
      expiresAt: deviceCode.expiresAtMs,
    });
  } catch {
    // Terminal presentation is observational, so a local output error cannot change MiniMax's polling flow (D22 step 3 design §7).
  }

  const configuredInterval = options.pollIntervalMs;
  const intervalMs = Math.max(
    MINIMAX_POLL_INTERVAL_MS,
    deviceCode.intervalMs,
    typeof configuredInterval === 'number' && Number.isFinite(configuredInterval)
      ? configuredInterval
      : MINIMAX_POLL_INTERVAL_MS,
  );
  const timeoutAt =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? requestedAt + Math.max(0, options.timeoutMs)
      : deviceCode.expiresAtMs;
  const deadline = Math.min(deviceCode.expiresAtMs, timeoutAt);
  const endpoint = `${MINIMAX_OAUTH_ENDPOINTS[options.region].accountBase}/oauth2/token`;

  while (true) {
    const remaining = deadline - options.now();
    if (remaining <= 0) throw timeoutError();
    await wait(Math.min(intervalMs, remaining));
    if (options.now() >= deadline) throw timeoutError();

    const result = await postForm(
      options.fetch,
      endpoint,
      new URLSearchParams({
        grant_type: MINIMAX_TOKEN_GRANT_TYPE,
        client_id: options.clientId,
        user_code: deviceCode.userCode,
        code_verifier: deviceCode.codeVerifier,
      }),
      Math.max(1_000, Math.min(MINIMAX_REQUEST_TIMEOUT_MS, deadline - options.now())),
    );
    if (options.now() >= deadline) throw timeoutError();
    if (result.reply === undefined) {
      throw new OAuthFlowError('EXCHANGE_FAILED', 'MiniMax returned an unreadable token reply.');
    }

    const status = result.reply.status;
    if (status === 'pending') {
      if (isCancellationMessage(messageFromReply(result.reply))) {
        throw new OAuthFlowError('CANCELLED', 'MiniMax sign-in was cancelled.');
      }
      continue;
    }
    if (status === 'error') {
      // The server's own text is not repeated: a sign-in message never carries a provider's reply (PLAN-v4 §6b).
      throw new OAuthFlowError('EXCHANGE_FAILED', 'MiniMax reported an error while signing in.');
    }
    if (status !== 'success' || !result.response.ok) {
      throw new OAuthFlowError('EXCHANGE_FAILED', 'MiniMax returned an invalid token reply.');
    }

    return tokenRecordFromReply(result.reply, {
      clientId: options.clientId,
      region: options.region,
      now: options.now,
    });
  }
}

/**
 * Exchanges a saved refresh token and saves its complete replacement in one call. A newly returned refresh token
 * replaces the old one; if MiniMax omits it, the old one remains in the record.
 */
export async function refreshMiniMaxTokens(input: {
  readonly record: MiniMaxTokenRecord;
  readonly fetch: FetchLike;
  readonly now: () => number;
  readonly save: (record: MiniMaxTokenRecord) => Promise<void>;
}): Promise<MiniMaxTokenRecord> {
  const endpoint = `${MINIMAX_OAUTH_ENDPOINTS[input.record.region].accountBase}/oauth2/token`;
  const result = await postForm(
    input.fetch,
    endpoint,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: input.record.clientId,
      refresh_token: input.record.refreshToken,
    }),
    MINIMAX_REQUEST_TIMEOUT_MS,
  );
  const reply = result.reply;
  if (reply === undefined) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'MiniMax could not refresh this sign-in.');
  }
  if (reply.status === 'error') {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'MiniMax could not refresh this sign-in.');
  }
  if (!result.response.ok) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'MiniMax could not refresh this sign-in.');
  }
  if (reply.status !== 'success') {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'MiniMax returned an invalid refresh reply.');
  }
  const accessToken = stringOf(reply, 'access_token');
  const expiresAt = tokenExpiry(reply.expired_in, input.now());
  if (expiresAt === undefined) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'MiniMax did not return a valid token expiry.');
  }
  const rotated = reply.refresh_token;
  const resourceUrl = reply.resource_url;
  const next: MiniMaxTokenRecord = {
    ...input.record,
    accessToken,
    refreshToken:
      typeof rotated === 'string' && rotated.length > 0 ? rotated : input.record.refreshToken,
    accessExpiresAt: expiresAt,
    ...(typeof resourceUrl === 'string' && resourceUrl.length > 0
      ? { resourceUrl }
      : input.record.resourceUrl === undefined
        ? {}
        : { resourceUrl: input.record.resourceUrl }),
  };
  await input.save(next);
  return next;
}

/** Keeps one MiniMax token refresh in flight per profile so a rotated refresh token is never spent twice. */
export function createMiniMaxTokenKeeper(deps: MiniMaxTokenKeeperDeps): MiniMaxTokenKeeper {
  const marginMs = deps.marginMs ?? MINIMAX_ACCESS_TOKEN_REFRESH_MARGIN_MS;
  const refreshing = new Map<string, Promise<MiniMaxTokenRecord>>();
  return {
    current(profileId, handleId, record) {
      if (record.accessExpiresAt - deps.now() > marginMs) return Promise.resolve(record);
      const inFlight = refreshing.get(profileId);
      if (inFlight !== undefined) return inFlight;
      const refresh = refreshMiniMaxTokens({
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

/** Encodes the whole MiniMax token record as the profile's one secret. */
export function encodeMiniMaxTokenRecord(record: MiniMaxTokenRecord): string {
  return JSON.stringify(record);
}

/** Decodes the record a MiniMax profile secret holds, or returns undefined when the secret is not one. */
export function decodeMiniMaxTokenRecord(text: string): MiniMaxTokenRecord | undefined {
  const parsed = parseReplyObject(text);
  if (parsed === undefined || parsed.version !== 1) return undefined;
  const { clientId, region, accessToken, refreshToken, accessExpiresAt, resourceUrl } = parsed;
  if (
    typeof clientId !== 'string' ||
    (region !== 'global' && region !== 'cn') ||
    typeof accessToken !== 'string' ||
    typeof refreshToken !== 'string' ||
    typeof accessExpiresAt !== 'number' ||
    !Number.isFinite(accessExpiresAt) ||
    ('resourceUrl' in parsed && typeof resourceUrl !== 'string')
  ) {
    return undefined;
  }
  return {
    version: 1,
    clientId,
    region,
    accessToken,
    refreshToken,
    accessExpiresAt,
    ...(typeof resourceUrl === 'string' ? { resourceUrl } : {}),
  };
}

async function requestDeviceCode(
  input: Pick<MiniMaxSignInOptions, 'clientId' | 'region' | 'fetch' | 'now'>,
  state: string,
  codeChallenge: string,
  codeVerifier: string,
): Promise<Omit<MiniMaxDeviceCode, 'state'>> {
  const endpoint = `${MINIMAX_OAUTH_ENDPOINTS[input.region].accountBase}/oauth2/device/code`;
  const result = await postForm(
    input.fetch,
    endpoint,
    new URLSearchParams({
      response_type: 'code',
      client_id: input.clientId,
      scope: MINIMAX_SCOPE,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    }),
    MINIMAX_REQUEST_TIMEOUT_MS,
  );
  if (!result.response.ok) {
    throw new OAuthFlowError(
      'EXCHANGE_FAILED',
      `MiniMax did not issue a device code (HTTP ${result.response.status}).`,
    );
  }
  const reply = result.reply;
  if (reply === undefined) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'MiniMax returned an unreadable device-code reply.');
  }
  const userCode = nonEmptyString(reply.user_code);
  const verificationUri = nonEmptyString(reply.verification_uri);
  const expiresAtMs = reply.expired_in;
  if (
    userCode === undefined ||
    verificationUri === undefined ||
    typeof expiresAtMs !== 'number' ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs < 1_000_000_000 ||
    expiresAtMs <= input.now()
  ) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'MiniMax returned an incomplete device-code reply.');
  }
  assertApprovalOrigin(verificationUri, input.region);
  if (reply.state !== state) {
    throw new OAuthFlowError('STATE_MISMATCH', 'MiniMax returned a different device authorization state.');
  }
  const intervalMsRaw = reply.interval;
  const intervalMs =
    typeof intervalMsRaw === 'number' && Number.isFinite(intervalMsRaw) && intervalMsRaw > 0
      ? Math.max(MINIMAX_POLL_INTERVAL_MS, Math.ceil(intervalMsRaw))
      : MINIMAX_POLL_INTERVAL_MS;
  return { userCode, verificationUri, expiresAtMs, intervalMs, codeVerifier };
}

/**
 * The approve page comes from the server's reply, so its host is checked before the owner's browser is sent to it. Only
 * MiniMax's own approve page for the region is accepted (PLAN-v4 §6d).
 */
function assertApprovalOrigin(verificationUri: string, region: MiniMaxRegion): void {
  const expected = new URL(MINIMAX_OAUTH_ENDPOINTS[region].authorizeUrl);
  let url: URL;
  try {
    url = new URL(verificationUri);
  } catch {
    throw new OAuthFlowError('REDIRECT_REFUSED', 'MiniMax returned an approve page on another host.');
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new OAuthFlowError('REDIRECT_REFUSED', 'MiniMax returned an approve page on another host.');
  }
}

/**
 * MiniMax's approve page reads the one-time code from the `user_code` parameter, so the code goes on the URL the
 * browser opens and the owner lands straight on the consent page instead of being asked for the code by hand
 * (PLAN-v4 §6d). The server's own query is kept.
 */
function approvalUrlFor(verificationUri: string, userCode: string): string {
  const url = new URL(verificationUri);
  url.searchParams.set('user_code', userCode);
  return url.toString();
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
      throw new OAuthFlowError('EXCHANGE_FAILED', 'MiniMax could not be reached.');
    }
    return { response, reply: parseReplyObject(await replyText(response)) };
  } finally {
    // The request is given up on when it does not answer in time, so a stalled request cannot outlive the flow.
    clearTimeout(timer);
  }
}

function tokenRecordFromReply(
  reply: Record<string, unknown>,
  input: {
    readonly clientId: string;
    readonly region: MiniMaxRegion;
    readonly now: () => number;
  },
): MiniMaxTokenRecord {
  const accessToken = stringOf(reply, 'access_token');
  const refreshToken = stringOf(reply, 'refresh_token');
  const accessExpiresAt = tokenExpiry(reply.expired_in, input.now());
  if (accessExpiresAt === undefined) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'MiniMax did not return a valid token expiry.');
  }
  const resourceUrl = nonEmptyString(reply.resource_url);
  return {
    version: 1,
    clientId: input.clientId,
    region: input.region,
    accessToken,
    refreshToken,
    accessExpiresAt,
    ...(resourceUrl === undefined ? {} : { resourceUrl }),
  };
}

function tokenExpiry(value: unknown, now: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  if (value < MINIMAX_RELATIVE_EXPIRY_SECONDS_THRESHOLD) return now + value * 1000;
  if (value < MINIMAX_ABSOLUTE_EXPIRY_MS_THRESHOLD) return value * 1000;
  return value;
}

function stringOf(reply: Record<string, unknown>, name: string): string {
  const value = reply[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new OAuthFlowError('EXCHANGE_FAILED', `MiniMax did not return ${name}.`);
  }
  return value;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function messageFromReply(reply: Record<string, unknown>): string | undefined {
  const baseResp = reply.base_resp;
  if (isRecord(baseResp)) {
    const statusMessage = nonEmptyString(baseResp.status_msg);
    if (statusMessage !== undefined) return statusMessage;
  }
  return nonEmptyString(reply.notification_message);
}

function isCancellationMessage(message: string | undefined): boolean {
  return message !== undefined && /cancel|declin|denied|reject|closed the (approval )?page/i.test(message);
}

function assertClientId(clientId: string): void {
  if (clientId.trim().length === 0) {
    throw new OAuthFlowError(
      'NOT_CONFIGURED',
      "MiniMax sign-in needs JOY Media's registered client ID.",
    );
  }
}

function timeoutError(): OAuthFlowError {
  return new OAuthFlowError('TIMEOUT', 'MiniMax device authorization timed out.');
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
