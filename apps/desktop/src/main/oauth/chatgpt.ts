import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';
import {
  CHATGPT_AUTHORIZE_URL,
  CHATGPT_ISSUER,
  CHATGPT_JWKS_URL,
  CHATGPT_TOKEN_URL,
} from '@joy-media/provider-sdk';
import { isRecord } from '../providers/request-body.js';
import { OAuthFlowError } from './errors.js';
import { type FetchLike, parseReplyObject, replyText } from './http.js';
import { startLoopbackCallback } from './loopback.js';
import { createPkcePair, randomToken } from './pkce.js';

/**
 * The ChatGPT sign-in endpoints, from the issuer's OpenID discovery document (PLAN-v4 §6d; checked 2026-10-29).
 */
export { CHATGPT_AUTHORIZE_URL, CHATGPT_ISSUER, CHATGPT_JWKS_URL, CHATGPT_TOKEN_URL };
/**
 * The scope a ChatGPT sign-in must be granted (PLAN-v4 §6d). The discovery document does not list it, so the owner's
 * attended sign-in is what confirms it.
 */
export const CHATGPT_REQUIRED_SCOPE = 'chatgpt.tokens.use.direct';
export const CHATGPT_SCOPE = `openid profile email offline_access ${CHATGPT_REQUIRED_SCOPE}`;
/** UNVERIFIED: the fixed loopback port and path. Only the owner's attended sign-in can confirm them. */
export const CHATGPT_CALLBACK_PORT = 1455;
export const CHATGPT_CALLBACK_PATH = '/auth/callback';
/** A refresh starts when the access token has less than this left (PLAN-v4 §6d: refresh just before a request). */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;
/** The clock skew allowed on an ID token's times, in seconds. */
const CLOCK_SKEW_SECONDS = 60;

/** What a signed-in ChatGPT account keeps. The whole record is one secret, so it is written in one call (PLAN-v4 §6d). */
export interface ChatGptTokenRecord {
  readonly version: 1;
  readonly clientId: string;
  /** The `sub` claim of the verified ID token. */
  readonly accountId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch milliseconds at which the access token expires. */
  readonly accessExpiresAt: number;
}

export interface ChatGptCode {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string;
  readonly expiresInSeconds: number;
}

export interface ChatGptSignInOptions {
  /** The OAuth client this build signs in with. Undefined until the owner decides it, so sign-in is refused. */
  readonly clientId: string | undefined;
  /** The ID this install sends. It is created once per install (PLAN-v4 §6d). */
  readonly extAgentHostId: string;
  /** Opens the system browser on the sign-in page. Injected, so the flow never opens one by itself. */
  readonly openExternal: (url: string) => void | Promise<void>;
  readonly fetch: FetchLike;
  readonly now: () => number;
  readonly timeoutMs?: number;
  /** Defaults to the fixed callback port. Tests pass 0. */
  readonly port?: number;
}

export interface ChatGptTokenKeeperDeps {
  readonly fetch: FetchLike;
  readonly now: () => number;
  /** Saves the whole record for a profile in one write. */
  readonly save: (profileId: string, record: ChatGptTokenRecord) => Promise<void>;
  readonly marginMs?: number;
}

export interface ChatGptTokenKeeper {
  /** The record to send with. It is refreshed first only when its access token is close to expiry. */
  current(profileId: string, record: ChatGptTokenRecord): Promise<ChatGptTokenRecord>;
}

export function buildChatGptAuthUrl(input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly extAgentHostId: string;
}): string {
  assertLoopbackRedirect(input.redirectUri);
  const url = new URL(CHATGPT_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', CHATGPT_SCOPE);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('ext_agent_host_id', input.extAgentHostId);
  return url.toString();
}

/** The redirect is a 127.0.0.1 address on the fixed path, never `localhost` (PLAN-v4 §6d). */
export function assertLoopbackRedirect(redirectUri: string): void {
  const url = new URL(redirectUri);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== CHATGPT_CALLBACK_PATH
  ) {
    throw new OAuthFlowError(
      'REDIRECT_REFUSED',
      'The ChatGPT redirect must be 127.0.0.1 on the fixed callback path.',
    );
  }
}

/** Exchanges the authorization code. The granted scope must include the required one. */
export async function exchangeChatGptCode(input: {
  readonly clientId: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly fetch: FetchLike;
}): Promise<ChatGptCode> {
  const reply = await postToken(
    input.fetch,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    }),
  );
  if (!grantedScopes(reply).includes(CHATGPT_REQUIRED_SCOPE)) {
    throw new OAuthFlowError('MISSING_SCOPE', 'ChatGPT did not grant the access this app needs.');
  }
  return {
    accessToken: stringOf(reply, 'access_token'),
    refreshToken: stringOf(reply, 'refresh_token'),
    idToken: stringOf(reply, 'id_token'),
    expiresInSeconds: secondsOf(reply, 'expires_in'),
  };
}

/**
 * Checks an ID token: its RS256 signature against the issuer's key of the same `kid`, the issuer, the audience, the
 * expiry (with a short clock skew) and the nonce (PLAN-v4 §6d). Returns the subject claim.
 */
export async function verifyIdToken(input: {
  readonly idToken: string;
  readonly clientId: string;
  readonly nonce: string;
  readonly fetch: FetchLike;
  readonly nowSeconds: number;
}): Promise<{ readonly sub: string }> {
  const refuse = (): never => {
    throw new OAuthFlowError('ID_TOKEN_INVALID', 'The ChatGPT sign-in could not be verified.');
  };
  const [encodedHeader, encodedPayload, encodedSignature, extra] = input.idToken.split('.');
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined ||
    extra !== undefined
  ) {
    return refuse();
  }
  const header = decodePart(encodedHeader);
  const payload = decodePart(encodedPayload);
  if (header === undefined || payload === undefined) return refuse();
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return refuse();

  const jwk = await signingKeyFor(header.kid, input.fetch);
  if (jwk === undefined) return refuse();
  if (!signatureValid(`${encodedHeader}.${encodedPayload}`, encodedSignature, jwk)) return refuse();

  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== CHATGPT_ISSUER || !audience.includes(input.clientId)) return refuse();
  if (payload.nonce !== input.nonce) return refuse();
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SECONDS <= input.nowSeconds) {
    return refuse();
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) return refuse();
  return { sub: payload.sub };
}

/**
 * Exchanges the refresh token for new tokens. A rotated refresh token replaces the old one in the same record, and the
 * record is saved in one call. When that call fails, nothing else was written, so the old record stays usable
 * (PLAN-v4 §6d: atomic rotation).
 */
export async function refreshChatGptTokens(input: {
  readonly record: ChatGptTokenRecord;
  readonly fetch: FetchLike;
  readonly now: () => number;
  readonly save: (record: ChatGptTokenRecord) => Promise<void>;
}): Promise<ChatGptTokenRecord> {
  const reply = await postToken(
    input.fetch,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: input.record.clientId,
      refresh_token: input.record.refreshToken,
    }),
  );
  const rotated = reply.refresh_token;
  const next: ChatGptTokenRecord = {
    ...input.record,
    accessToken: stringOf(reply, 'access_token'),
    refreshToken:
      typeof rotated === 'string' && rotated.length > 0 ? rotated : input.record.refreshToken,
    accessExpiresAt: input.now() + secondsOf(reply, 'expires_in') * 1000,
  };
  await input.save(next);
  return next;
}

/**
 * Keeps one refresh in flight per profile. Two requests that find the access token expired share one refresh, so a
 * rotated refresh token is never spent twice (PLAN-v4 §6d).
 */
export function createChatGptTokenKeeper(deps: ChatGptTokenKeeperDeps): ChatGptTokenKeeper {
  const marginMs = deps.marginMs ?? ACCESS_TOKEN_REFRESH_MARGIN_MS;
  const refreshing = new Map<string, Promise<ChatGptTokenRecord>>();
  return {
    current(profileId, record) {
      if (record.accessExpiresAt - deps.now() > marginMs) return Promise.resolve(record);
      const inFlight = refreshing.get(profileId);
      if (inFlight !== undefined) return inFlight;
      const refresh = refreshChatGptTokens({
        record,
        fetch: deps.fetch,
        now: deps.now,
        save: (next) => deps.save(profileId, next),
      }).finally(() => refreshing.delete(profileId));
      refreshing.set(profileId, refresh);
      return refresh;
    },
  };
}

/**
 * Runs one ChatGPT sign-in and returns the record to keep (PLAN-v4 §6d). The listener is closed however the flow ends.
 */
export async function signInWithChatGpt(
  options: ChatGptSignInOptions,
): Promise<ChatGptTokenRecord> {
  const clientId = options.clientId;
  if (clientId === undefined || clientId.length === 0) {
    throw new OAuthFlowError(
      'NOT_CONFIGURED',
      'ChatGPT sign-in is not configured in this build yet.',
    );
  }
  const state = randomToken();
  const nonce = randomToken();
  const pkce = createPkcePair();
  const callback = await startLoopbackCallback({
    path: CHATGPT_CALLBACK_PATH,
    expectedState: state,
    port: options.port ?? CHATGPT_CALLBACK_PORT,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  try {
    await options.openExternal(
      buildChatGptAuthUrl({
        clientId,
        redirectUri: callback.redirectUri,
        state,
        nonce,
        codeChallenge: pkce.challenge,
        extAgentHostId: options.extAgentHostId,
      }),
    );
    const code = await callback.code;
    const tokens = await exchangeChatGptCode({
      clientId,
      code,
      codeVerifier: pkce.verifier,
      redirectUri: callback.redirectUri,
      fetch: options.fetch,
    });
    const claims = await verifyIdToken({
      idToken: tokens.idToken,
      clientId,
      nonce,
      fetch: options.fetch,
      nowSeconds: Math.floor(options.now() / 1000),
    });
    return {
      version: 1,
      clientId,
      accountId: claims.sub,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: options.now() + tokens.expiresInSeconds * 1000,
    };
  } finally {
    callback.close();
  }
}

export function encodeTokenRecord(record: ChatGptTokenRecord): string {
  return JSON.stringify(record);
}

/** The record a secret holds, or undefined when it is not one. Its text is never part of a result. */
export function decodeTokenRecord(text: string): ChatGptTokenRecord | undefined {
  const parsed = parseReplyObject(text);
  if (parsed === undefined || parsed.version !== 1) return undefined;
  const { clientId, accountId, accessToken, refreshToken, accessExpiresAt } = parsed;
  if (
    typeof clientId !== 'string' ||
    typeof accountId !== 'string' ||
    typeof accessToken !== 'string' ||
    typeof refreshToken !== 'string' ||
    typeof accessExpiresAt !== 'number'
  ) {
    return undefined;
  }
  return { version: 1, clientId, accountId, accessToken, refreshToken, accessExpiresAt };
}

async function postToken(
  fetchImpl: FetchLike,
  body: URLSearchParams,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(CHATGPT_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
      redirect: 'manual',
    });
  } catch {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'ChatGPT could not be reached.');
  }
  const reply = parseReplyObject(await replyText(response));
  if (!response.ok) {
    if (reply?.error === 'invalid_grant') {
      throw new OAuthFlowError('SIGN_IN_REQUIRED', 'ChatGPT needs a new sign-in.');
    }
    throw new OAuthFlowError(
      'EXCHANGE_FAILED',
      `ChatGPT did not issue tokens (HTTP ${response.status}).`,
    );
  }
  if (reply === undefined) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'ChatGPT returned an unreadable reply.');
  }
  return reply;
}

function grantedScopes(reply: Record<string, unknown>): readonly string[] {
  return typeof reply.scope === 'string' ? reply.scope.split(' ') : [];
}

function stringOf(reply: Record<string, unknown>, name: string): string {
  const value = reply[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new OAuthFlowError('EXCHANGE_FAILED', `ChatGPT did not return ${name}.`);
  }
  return value;
}

function secondsOf(reply: Record<string, unknown>, name: string): number {
  const value = reply[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new OAuthFlowError('EXCHANGE_FAILED', `ChatGPT did not return ${name}.`);
  }
  return value;
}

function decodePart(part: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function signingKeyFor(kid: string, fetchImpl: FetchLike): Promise<JsonWebKey | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(CHATGPT_JWKS_URL, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
    });
  } catch {
    throw new OAuthFlowError('ID_TOKEN_INVALID', 'The ChatGPT sign-in could not be verified.');
  }
  const keys = parseReplyObject(await replyText(response))?.keys;
  if (!response.ok || !Array.isArray(keys)) return undefined;
  return keys.find(
    (key: unknown): key is JsonWebKey => isRecord(key) && key.kid === kid && key.kty === 'RSA',
  );
}

function signatureValid(signingInput: string, signature: string, jwk: JsonWebKey): boolean {
  try {
    return createVerify('RSA-SHA256')
      .update(signingInput)
      .verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}
