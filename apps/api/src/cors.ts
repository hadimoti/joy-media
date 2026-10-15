import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Browser origins allowed to call the API cross-origin. The site itself is same-origin (/api);
 * the packaged desktop renderer runs on joy-media-app://renderer (apps/desktop/src/main/window.ts)
 * and calls https://joyst.ir/api, so its JSON POSTs are preflighted.
 */
export const DEFAULT_CORS_ALLOWED_ORIGINS: readonly string[] = [
  'https://joyst.ir',
  'https://www.joyst.ir',
  'joy-media-app://renderer',
];

const CORS_ALLOWED_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';
const CORS_ALLOWED_HEADERS =
  'authorization, content-type, x-joy-bytes, x-joy-frame-count, x-joy-frame-rate, x-joy-mime-type';
const CORS_MAX_AGE_SECONDS = '600';

/** The default list plus JOY_MEDIA_CORS_EXTRA_ORIGINS (comma separated); "*" and "null" are ignored. */
export function corsAllowedOriginsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlySet<string> {
  const extra = (env.JOY_MEDIA_CORS_EXTRA_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0 && origin !== '*' && origin !== 'null');
  return new Set([...DEFAULT_CORS_ALLOWED_ORIGINS, ...extra]);
}

/**
 * Applies CORS for an explicit origin allow-list, before routing and authentication.
 * - A preflight (OPTIONS with Access-Control-Request-Method) from an allowed origin gets 204 with
 *   the allow headers; from any other origin, 403 with no Access-Control-* headers.
 * - Other requests from an allowed origin get Access-Control-Allow-Origin echoing that origin.
 * Never a wildcard, and never Access-Control-Allow-Credentials: the API uses bearer tokens.
 * Returns true when the response was already sent.
 */
export function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
  const allowed = origin !== undefined && allowedOrigins.has(origin);
  if (origin !== undefined) response.setHeader('vary', 'Origin');
  const preflight =
    request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined;
  if (preflight) {
    if (!allowed) {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: { code: 'CORS_ORIGIN_NOT_ALLOWED', message: 'Origin not allowed' },
        }),
      );
      return true;
    }
    response.writeHead(204, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': CORS_ALLOWED_METHODS,
      'access-control-allow-headers': CORS_ALLOWED_HEADERS,
      'access-control-max-age': CORS_MAX_AGE_SECONDS,
    });
    response.end();
    return true;
  }
  if (allowed) response.setHeader('access-control-allow-origin', origin);
  return false;
}
