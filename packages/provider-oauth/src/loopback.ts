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
  /** Aborting it cancels the flow: the listener closes and the port is freed (T-J03). */
  readonly signal?: AbortSignal;
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
  /**
   * Resolves once the listener is really closed and the port is free. A new listener on the same
   * fixed port must wait for it (T-J03): `server.close()` alone releases the port asynchronously.
   */
  readonly closed: Promise<void>;
}

/** The JOY Media look for the sign-in page: black ground, light text, the gold accent of the app (app.css). */
const SIGN_IN_PAGE_CSS = [
  'html,body{height:100%;margin:0}',
  'body{display:flex;align-items:center;justify-content:center;background:#000000;color:#ececef;',
  "font-family:'Inter Variable','Vazirmatn Variable','Noto Sans Arabic',Tahoma,system-ui,sans-serif}",
  'main{display:flex;flex-direction:column;align-items:center;gap:12px;padding:32px;text-align:center}',
  '.brand{margin:0 0 12px;font-size:20px;font-weight:700;letter-spacing:0.02em}',
  '.brand span{color:#f4b72f}',
  'svg{width:56px;height:56px}',
  'h1{margin:8px 0 0;font-size:22px;font-weight:600}',
  'p.note{margin:0;font-size:15px;color:#a8a8b0}',
].join('');

const SUCCESS_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#f4b72f"/>' +
  '<path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#1a1408" stroke-width="2.4" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FAILURE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#e8705f"/>' +
  '<path d="M8 8l8 8M16 8l-8 8" fill="none" stroke="#1a1408" stroke-width="2.4" ' +
  'stroke-linecap="round"/></svg>';

/** A static page in the app's style. Its wording is fixed here, so it never echoes a parameter back. */
function signInPage(title: string, note: string, succeeded: boolean): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">',
    '<title>JOY Media</title>',
    `<style>${SIGN_IN_PAGE_CSS}</style>`,
    '</head><body><main>',
    '<p class="brand"><span>JOY</span> Media</p>',
    succeeded ? SUCCESS_ICON : FAILURE_ICON,
    `<h1>${title}</h1>`,
    `<p class="note">${note}</p>`,
    '</main></body></html>',
  ].join('');
}

const PAGE_DONE = signInPage(
  'Sign-in complete',
  'You can close this window and return to JOY Media.',
  true,
);
const PAGE_FAILED = signInPage(
  'Sign-in did not complete',
  'Return to JOY Media and try again.',
  false,
);

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
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  server.once('close', () => resolveClosed());

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

  if (options.signal !== undefined) {
    if (options.signal.aborted) close();
    else options.signal.addEventListener('abort', close, { once: true });
  }

  return {
    redirectUri: `http://${LOOPBACK_HOST}:${address.port}${options.path}`,
    code,
    clientId,
    close,
    closed,
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
