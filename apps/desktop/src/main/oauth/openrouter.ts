import {
  OPENROUTER_AUTH_URL,
  OPENROUTER_BASE_URL,
  OPENROUTER_KEY_EXCHANGE_URL,
} from '@joy-media/provider-sdk';
import { JOY_TITLE, JOY_TITLE_HEADER } from '../providers/adapters/types.js';
import { OAuthFlowError } from './errors.js';
import { type FetchLike, parseReplyObject, replyText } from './http.js';
import { startLoopbackCallback } from './loopback.js';
import { createPkcePair, randomToken } from './pkce.js';

export { OPENROUTER_AUTH_URL, OPENROUTER_BASE_URL, OPENROUTER_KEY_EXCHANGE_URL };
/** The path the browser returns to on the loopback listener (PLAN-v4 §6d). */
export const OPENROUTER_CALLBACK_PATH = '/callback';

export interface OpenRouterSignInOptions {
  /** Opens the system browser on the sign-in page. Injected, so the flow never opens one by itself. */
  readonly openExternal: (url: string) => void | Promise<void>;
  readonly fetch: FetchLike;
  readonly timeoutMs?: number;
  /** 0, the default, picks a free port. */
  readonly port?: number;
}

export function buildOpenRouterAuthUrl(input: {
  readonly callbackUrl: string;
  readonly codeChallenge: string;
  readonly state: string;
}): string {
  const url = new URL(OPENROUTER_AUTH_URL);
  url.searchParams.set('callback_url', input.callbackUrl);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  return url.toString();
}

/** Exchanges the code for the key it names. The reply's text is never part of an error. */
export async function exchangeOpenRouterCode(input: {
  readonly code: string;
  readonly codeVerifier: string;
  readonly fetch: FetchLike;
}): Promise<string> {
  let response: Response;
  try {
    response = await input.fetch(OPENROUTER_KEY_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [JOY_TITLE_HEADER]: JOY_TITLE },
      body: JSON.stringify({
        code: input.code,
        code_verifier: input.codeVerifier,
        code_challenge_method: 'S256',
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'OpenRouter could not be reached.');
  }
  if (!response.ok) {
    throw new OAuthFlowError(
      'EXCHANGE_FAILED',
      `OpenRouter did not return a key (HTTP ${response.status}).`,
    );
  }
  const key = parseReplyObject(await replyText(response))?.key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'OpenRouter did not return a key.');
  }
  return key;
}

/**
 * Runs one OpenRouter sign-in and returns the key it issues (PLAN-v4 §6d). The caller stores that key as a normal
 * key. The key is never logged, and the listener closes however the flow ends.
 */
export async function signInWithOpenRouter(options: OpenRouterSignInOptions): Promise<string> {
  const state = randomToken();
  const pkce = createPkcePair();
  const callback = await startLoopbackCallback({
    path: OPENROUTER_CALLBACK_PATH,
    expectedState: state,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  try {
    await options.openExternal(
      buildOpenRouterAuthUrl({
        callbackUrl: callback.redirectUri,
        codeChallenge: pkce.challenge,
        state,
      }),
    );
    const code = await callback.code;
    return await exchangeOpenRouterCode({
      code,
      codeVerifier: pkce.verifier,
      fetch: options.fetch,
    });
  } finally {
    callback.close();
  }
}
