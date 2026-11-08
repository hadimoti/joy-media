/*
 * The pinned transport for a public custom endpoint (S8, PLAN-v4 §6c). It is Node-only: it resolves names and opens
 * HTTPS sockets. The browser editor also imports joy-agent-engine, so that package must never import this module.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import type { JoyFetch } from '@joy-media/joy-agent-engine';
import { isPrivateOrInternalHost } from '@joy-media/provider-sdk';

/** The addresses a name resolves to now. Tests inject their own, so that they never touch DNS. */
export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

/** https.request. Tests inject their own, so that they never open a socket. */
export type HttpsRequest = typeof httpsRequest;

export interface PublicEndpointFetchOptions {
  readonly resolveHost?: ResolveHost | undefined;
  readonly request?: HttpsRequest | undefined;
}

/** The system resolver: every address the name resolves to, in the order the resolver gives them. */
export const resolveSystemHost: ResolveHost = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((record) => record.address);

/**
 * A connection lookup that answers only with the addresses vetted for one request, never with a fresh DNS answer.
 * It answers both lookup shapes: one address, or the full list when the socket asks for it.
 */
export function pinnedLookup(addresses: readonly string[]): LookupFunction {
  const records = addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  return (_hostname, options, callback) => {
    const first = records[0];
    if (first === undefined) {
      callback(new Error('No vetted address is pinned for this request.'), '', 0);
      return;
    }
    if (options.all === true) {
      callback(null, records);
      return;
    }
    callback(null, first.address, first.family);
  };
}

/**
 * IPv6 ranges that carry an IPv4 address a kernel, a NAT64 gateway or a 6to4 relay can deliver to: the IPv4-compatible
 * ::/96, the translated ::ffff:0:0:0/96, the NAT64 prefixes 64:ff9b::/96 and 64:ff9b:1::/48, and 6to4 2002::/16. The
 * shared address check does not list them, so this transport refuses them as well.
 */
const embeddedIpv4Ranges = new BlockList();
for (const [network, prefix] of [
  ['::', 96],
  ['::ffff:0:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2002::', 16],
] as const) {
  embeddedIpv4Ranges.addSubnet(network, prefix, 'ipv6');
}

/**
 * Whether an address is refused for a public endpoint: the shared private-address rule, the embedded-IPv4 ranges above,
 * and any address with a zone, which no DNS answer should carry.
 */
function isRefusedAddress(address: string): boolean {
  if (address.includes('%') || isPrivateOrInternalHost(address)) return true;
  return isIP(address) === 6 && embeddedIpv4Ranges.check(address, 'ipv6');
}

/** A refusal has the shape of a failed fetch, so the CLI reports it as a network error with this code. */
function refused(reason: string): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(reason), { code: 'ENDPOINT_REFUSED' }),
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Settles with the work, unless the signal aborts first. An abort rejects with the reason the caller gave. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** The name's answer. A resolver failure is a failed fetch, as the global fetch reports one; an abort passes on as it is. */
async function answerFor(
  resolveHost: ResolveHost,
  hostname: string,
  signal: AbortSignal | undefined,
): Promise<readonly string[]> {
  try {
    return await untilAborted(resolveHost(hostname), signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new TypeError('fetch failed', { cause: error });
  }
}

/** The bytes of a request body. Text and binary bodies are sent; a stream is refused, since it cannot be sent here. */
function bodyBytes(body: RequestInit['body']): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('A public endpoint request body must be text or bytes.');
}

function headerRecord(headers: RequestInit['headers']): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

/** The reply as a Response. A redirect is returned as it is, and is never followed. */
function toResponse(reply: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(reply.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  // The Response constructor throws outside 200-599, so such a status becomes a bad gateway.
  const status =
    reply.statusCode !== undefined && reply.statusCode >= 200 && reply.statusCode <= 599
      ? reply.statusCode
      : 502;
  const init = { status, statusText: reply.statusMessage ?? '', headers };
  if (status === 204 || status === 205 || status === 304) {
    reply.resume();
    return new Response(null, init);
  }
  return new Response(
    Readable.toWeb(reply) as unknown as ConstructorParameters<typeof Response>[0],
    init,
  );
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** A redirect as the fetch API defines it: a redirect status with a Location header. */
function isRedirect(reply: IncomingMessage): boolean {
  return REDIRECT_STATUSES.has(reply.statusCode ?? 0) && reply.headers.location !== undefined;
}

/** One HTTPS request to the vetted addresses: a fresh socket, the name kept for TLS, and no redirect followed. */
function sendPinned(
  url: URL,
  hostname: string,
  addresses: readonly string[],
  init: RequestInit | undefined,
  body: Buffer | undefined,
  request: HttpsRequest,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const headers = headerRecord(init?.headers);
    if (body !== undefined && headers['content-length'] === undefined) {
      headers['content-length'] = String(body.byteLength);
    }
    const req = request(
      {
        protocol: 'https:',
        hostname,
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? 'GET',
        headers,
        // The name stays for SNI and the certificate check. An IP literal has no name to send.
        ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
        // No pooled socket: every request connects again, to the addresses vetted for that request.
        agent: false,
        lookup: pinnedLookup(addresses),
      },
      (reply) => {
        try {
          if (init?.redirect === 'error' && isRedirect(reply)) {
            throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
          }
          resolve(toResponse(reply));
        } catch (error) {
          reply.resume();
          reject(error);
        }
      },
    );
    // A socket or TLS failure is a failed fetch, as undici reports it. An abort keeps the reason the caller gave.
    req.on('error', (error) => {
      reject(signal?.aborted ? error : new TypeError('fetch failed', { cause: error }));
    });
    if (signal !== undefined) {
      const onAbort = (): void => {
        req.destroy(abortReason(signal) as Error);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      req.once('close', () => signal.removeEventListener('abort', onAbort));
    }
    req.end(body);
  });
}

/**
 * A fetch for a public custom endpoint. Before each request the name is resolved again, and the request goes only to
 * addresses that are public. An answer that is private, loopback, link-local or internal is refused before any socket
 * opens. A redirect is returned as it is, unless the caller asks for an error, and it is never followed.
 */
export function createPublicEndpointFetch(options: PublicEndpointFetchOptions = {}): JoyFetch {
  const resolveHost = options.resolveHost ?? resolveSystemHost;
  const request = options.request ?? httpsRequest;
  return async (input, init) => {
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw abortReason(signal);
    if (input instanceof Request) {
      throw new TypeError('A public endpoint request takes a URL and options, not a Request.');
    }
    const url = new URL(input.toString());
    if (url.protocol !== 'https:') throw refused('A public endpoint must use HTTPS.');
    const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
    if (isRefusedAddress(hostname)) {
      throw refused('A public endpoint may not name a private, link-local or internal address.');
    }
    const body = bodyBytes(init?.body);
    const addresses = await answerFor(resolveHost, hostname, signal);
    if (addresses.length === 0 || addresses.some((address) => isRefusedAddress(address))) {
      throw refused('This endpoint name resolves to a private address.');
    }
    return sendPinned(url, hostname, addresses, init, body, request);
  };
}
