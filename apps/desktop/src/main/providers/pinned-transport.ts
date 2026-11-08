import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { isPrivateOrInternalHost } from '@joy-media/provider-sdk';

/** A fetch-shaped call. The broker sends only HTTPS requests to a pinned public host. */
export type PinnedFetch = (url: string, init: RequestInit) => Promise<Response>;

type HttpsRequest = typeof httpsRequest;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * The lookup used for a pinned connection. Every connection to the host goes to an address that was vetted
 * before the request (PLAN-v4 §6c item 4), never to a fresh DNS answer. Both lookup shapes are answered.
 */
export function pinnedLookup(addresses: readonly string[]) {
  const records = addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  return (
    _hostname: string,
    options: unknown,
    callback: (error: Error | null, address?: unknown, family?: number) => void,
  ): void => {
    const first = records[0];
    if (first === undefined) {
      callback(new Error('No vetted address is pinned for this host.'));
      return;
    }
    if (
      typeof options === 'object' &&
      options !== null &&
      (options as { all?: unknown }).all === true
    ) {
      callback(null, records);
      return;
    }
    callback(null, first.address, first.family);
  };
}

/**
 * Whether a pinned address is refused: the shared private-address rule, and any address with a zone, which no DNS
 * answer should carry. The CLI transport applies the same rule.
 */
function isRefusedAddress(address: string): boolean {
  return address.includes('%') || isPrivateOrInternalHost(address);
}

/** The bytes of a request body: text and binary bodies are sent. A stream is refused, since it cannot be sent here. */
function bodyBytes(body: RequestInit['body']): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('A public endpoint request body must be text or bytes.');
}

/**
 * A fetch for public custom endpoints. A host with a pin is reached over HTTPS at its vetted addresses only, with
 * the name kept for SNI and the Host header. Redirects are returned as they are, never followed, unless the caller
 * asks for an error. A host without a pin goes to the fallback, which is the ordinary fetch for loopback and registry
 * endpoints.
 */
export function pinnedFetch(
  pins: ReadonlyMap<string, readonly string[]>,
  fallback: PinnedFetch,
  request: HttpsRequest = httpsRequest,
): PinnedFetch {
  return (url, init) => {
    const target = new URL(url);
    const addresses = pins.get(target.hostname);
    if (addresses === undefined) return fallback(url, init);
    if (target.protocol !== 'https:') {
      return Promise.reject(new Error('A public endpoint must use HTTPS.'));
    }
    if (addresses.length === 0 || addresses.some((address) => isRefusedAddress(address))) {
      return Promise.reject(new Error('A pinned address for this endpoint is not public.'));
    }
    return new Promise<Response>((resolve, reject) => {
      let body: Buffer | undefined;
      try {
        body = bodyBytes(init.body);
      } catch (error) {
        reject(error);
        return;
      }
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      if (body !== undefined && headers['content-length'] === undefined) {
        headers['content-length'] = String(body.byteLength);
      }
      const req = request(
        {
          protocol: 'https:',
          hostname: target.hostname,
          port: target.port === '' ? 443 : Number(target.port),
          path: `${target.pathname}${target.search}`,
          method: init.method ?? 'GET',
          headers,
          servername: target.hostname,
          // No pooled socket: every request connects again, to the addresses vetted for that request.
          agent: false,
          lookup: pinnedLookup(addresses) as never,
        },
        (res) => {
          try {
            const isRedirect =
              REDIRECT_STATUSES.has(res.statusCode ?? 0) && res.headers.location !== undefined;
            if (init.redirect === 'error' && isRedirect) {
              res.resume();
              reject(new TypeError('fetch failed', { cause: new Error('unexpected redirect') }));
              return;
            }
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              for (const item of Array.isArray(value) ? value : [value])
                responseHeaders.append(name, item);
            }
            // The Response constructor takes only 200 to 599, so any other status becomes a bad gateway.
            const status =
              res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode <= 599
                ? res.statusCode
                : 502;
            const bodyless = status === 204 || status === 205 || status === 304;
            resolve(
              new Response(
                bodyless
                  ? null
                  : (Readable.toWeb(res) as unknown as ConstructorParameters<typeof Response>[0]),
                {
                  status,
                  statusText: res.statusMessage ?? '',
                  headers: responseHeaders,
                },
              ),
            );
          } catch (error) {
            res.resume();
            reject(error);
          }
        },
      );
      req.on('error', reject);
      const signal = init.signal;
      if (signal) {
        const abort = (): void => {
          req.destroy(new Error('The request was aborted.'));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
      if (body !== undefined) req.write(body);
      req.end();
    });
  };
}
