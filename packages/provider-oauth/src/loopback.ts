import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { OAuthFlowError } from './errors.js';

/** The only host a sign-in listens on and redirects to. `localhost` is never used (PLAN-v4 §6d). */
export const LOOPBACK_HOST = '127.0.0.1';
/** How long a sign-in waits for the browser to come back (PLAN-v4 §6d). */
export const CALLBACK_TIMEOUT_MS = 5 * 60_000;

export interface LoopbackCallbackOptions {
  /** The path the browser returns to, such as `/callback`. Any other path is ignored. */
  readonly path: string;
  /** The `state` the browser must return. A callback with any other state ends the flow. */
  readonly expectedState: string;
  /** 0, the default, picks a free port. A provider that registers one fixed port passes it. */
  readonly port?: number;
  readonly timeoutMs?: number;
}

export interface LoopbackCallback {
  /** Where the browser is sent back, such as `http://127.0.0.1:53412/callback`. */
  readonly redirectUri: string;
  /** Resolves with the authorization code. Rejects with an OAuthFlowError when the flow ends another way. */
  readonly code: Promise<string>;
  /**
   * Resolves with the client ID the callback named, when it named one (ChatGPT first-time registration).
   * Undefined when it named none, and when the flow ends without a code.
   */
  readonly clientId: Promise<string | undefined>;
  /** Stops listening. A flow still waiting is cancelled. Safe to call more than once. */
  close(): void;
}

const PAGE_DONE =
  '<!doctype html><meta charset="utf-8"><title>JOY Media</title>' +
  '<p>Sign-in complete. You can close this window.</p>';
const PAGE_FAILED =
  '<!doctype html><meta charset="utf-8"><title>JOY Media</title>' +
  '<p>Sign-in did not complete. Return to JOY Media and try again.</p>';

/**
 * Starts a one-shot listener on 127.0.0.1 for a provider's redirect (PLAN-v4 §6d). It takes the first callback on
 * the path, then stops listening. The page it shows never echoes a parameter back, and a request for any other
 * path or host name is answered with 404 and ignored.
 */
export async function startLoopbackCallback(
  options: LoopbackCallbackOptions,
): Promise<LoopbackCallback> {
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: OAuthFlowError) => void = () => undefined;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // A caller that closes the flow early never awaits `code`. This keeps that from being reported as unhandled.
  code.catch(() => undefined);
  let resolveClientId: (clientId: string | undefined) => void = () => undefined;
  const clientId = new Promise<string | undefined>((resolve) => {
    resolveClientId = resolve;
  });
  // The client ID the callback named, kept until the flow settles.
  let issuedClientId: string | undefined;

  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const server = createServer((request, response) => answer(request, response));

  const hostHeader = (): string => {
    const address = server.address();
    return address !== null && typeof address !== 'string'
      ? `${LOOPBACK_HOST}:${address.port}`
      : '';
  };

  // Settles the flow once: whichever of the page sent, the browser gone, the timeout or the caller's close comes first.
  let settled = false;
  const settle = (outcome: string | OAuthFlowError): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (server.listening) server.close();
    server.closeAllConnections();
    if (typeof outcome === 'string') {
      resolveCode(outcome);
      resolveClientId(issuedClientId);
    } else {
      rejectCode(outcome);
      resolveClientId(undefined);
    }
  };

  const answer = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
    // A request for another host name is refused, so a web page cannot drive the listener by DNS rebinding.
    if (
      finished ||
      request.headers.host !== hostHeader() ||
      request.method !== 'GET' ||
      url.pathname !== options.path
    ) {
      response.statusCode = 404;
      response.end();
      return;
    }
    finished = true;
    issuedClientId = clientIdOf(url);
    const outcome = outcomeOf(url, options.expectedState);
    const succeeded = typeof outcome === 'string';
    response.statusCode = succeeded ? 200 : 400;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    // The flow settles once the page is sent, or once the browser has gone before it arrived. A dropped connection
    // therefore cannot leave the sign-in waiting for a page that will never be sent.
    response.once('close', () => settle(outcome));
    response.end(succeeded ? PAGE_DONE : PAGE_FAILED, () => settle(outcome));
  };

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  }).catch(() => {
    throw new OAuthFlowError('LISTEN_FAILED', 'The sign-in could not listen on this computer.');
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new OAuthFlowError('LISTEN_FAILED', 'The sign-in could not listen on this computer.');
  }

  timer = setTimeout(() => {
    finished = true;
    settle(new OAuthFlowError('TIMEOUT', 'The sign-in was not finished in time.'));
  }, options.timeoutMs ?? CALLBACK_TIMEOUT_MS);

  const close = (): void => {
    finished = true;
    settle(new OAuthFlowError('CANCELLED', 'The sign-in was cancelled.'));
  };

  return {
    redirectUri: `http://${LOOPBACK_HOST}:${address.port}${options.path}`,
    code,
    clientId,
    close,
  };
}

/** The code, or the reason the flow ends. The state is checked before anything else (RFC 6749 §10.12). */
function outcomeOf(url: URL, expectedState: string): string | OAuthFlowError {
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  if (state !== expectedState) {
    return new OAuthFlowError(
      'STATE_MISMATCH',
      'The sign-in did not match the request that started it.',
    );
  }
  if (error === 'access_denied')
    return new OAuthFlowError('ACCESS_DENIED', 'The sign-in was declined.');
  if (error !== null) {
    return new OAuthFlowError('CALLBACK_ERROR', 'The provider ended the sign-in with an error.');
  }
  if (code === null || code.length === 0) {
    return new OAuthFlowError('CALLBACK_INVALID', 'The sign-in returned no code.');
  }
  return code;
}

/** The client ID a callback names: short, and only letters, digits, dots, dashes and underscores. */
function clientIdOf(url: URL): string | undefined {
  const value = url.searchParams.get('client_id');
  return value !== null && /^[A-Za-z0-9._-]{1,256}$/.test(value) ? value : undefined;
}
