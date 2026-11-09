/*
 * The pinned transport for public custom endpoints (S8, PLAN-v4 §6c). It is Node-only: it opens HTTPS sockets, so
 * browser code must never import this module. It follows the CLI transport (apps/cli/src/agent/public-endpoint-fetch.ts)
 * for connections, redirects, aborts and compressed replies.
 */
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Duplex, pipeline, Readable, type Transform } from 'node:stream';
import {
  constants,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createInflateRaw,
} from 'node:zlib';
import { KIMI_CODE_OAUTH_HOST, XAI_OAUTH_ISSUER } from '@joy-media/provider-oauth';
import {
  CHATGPT_ISSUER,
  isLoopbackHostname,
  isPrivateOrInternalHost,
  PROVIDER_REGISTRY,
} from '@joy-media/provider-sdk';

/** A fetch-shaped call. The broker sends HTTPS requests only to a pinned public host or to a host named below. */
export type PinnedFetch = (url: string, init: RequestInit) => Promise<Response>;

type HttpsRequest = typeof httpsRequest;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * The hosts a request may reach without a pin: the API host of each provider the registry names, and the sign-in host
 * of each provider that signs in with an account. A name outside this list has no vetted address, so it is refused
 * rather than sent through the ordinary fetch, which would resolve the name again.
 */
const NAMED_HOSTS: ReadonlySet<string> = new Set([
  new URL(CHATGPT_ISSUER).hostname,
  new URL(XAI_OAUTH_ISSUER).hostname,
  new URL(KIMI_CODE_OAUTH_HOST).hostname,
  ...PROVIDER_REGISTRY.flatMap((provider) =>
    provider.regions.map((region) => new URL(region.baseUrl).hostname),
  ),
]);

/** xAI's own domain: x.ai and its subdomains. */
function isXaiHostname(hostname: string): boolean {
  return hostname === 'x.ai' || hostname.endsWith('.x.ai');
}

/**
 * xAI's own domain, reached over HTTPS on the default port and without credentials. The sign-in code accepts the same
 * URLs for its discovered endpoints (isTrustedXaiUrl in packages/provider-oauth/src/xai.ts), so the transport does too.
 */
function isXaiTarget(target: URL): boolean {
  return (
    target.protocol === 'https:' &&
    isXaiHostname(target.hostname.toLowerCase()) &&
    target.username === '' &&
    target.password === '' &&
    target.port === ''
  );
}

function isUnpinnedHostAllowed(target: URL): boolean {
  // An x.ai name is judged by its URL alone, before the named-host list, so the named xAI hosts get the same checks.
  if (isXaiHostname(target.hostname.toLowerCase())) return isXaiTarget(target);
  return isLoopbackHostname(target.hostname) || NAMED_HOSTS.has(target.hostname);
}

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

function headerRecord(headers: RequestInit['headers']): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

/** The content codings the fetch API decodes. A reply in any other coding is passed through as it is. */
const DECODED_CODINGS: ReadonlySet<string> = new Set(['gzip', 'x-gzip', 'deflate', 'br']);

/** The content codings a reply names, in the order they were applied, leaving out identity. */
function contentCodings(value: string | string[] | undefined): string[] {
  const text = Array.isArray(value) ? value.join(',') : (value ?? '');
  return text
    .split(',')
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== '' && coding !== 'identity');
}

/** The flush options undici uses: a body that ends early is decoded as far as it goes, and an empty body is empty. */
const ZLIB_FLUSH = { flush: constants.Z_SYNC_FLUSH, finishFlush: constants.Z_SYNC_FLUSH };
const BROTLI_FLUSH = {
  flush: constants.BROTLI_OPERATION_FLUSH,
  finishFlush: constants.BROTLI_OPERATION_FLUSH,
};

/**
 * The deflate coding. Most servers send the zlib format (RFC 1950), but some send raw deflate (RFC 1951). As undici
 * does, the first byte decides: a zlib header has 8 as its compression method. The inflater is made on the first chunk,
 * and its output waits for the reader, so a slow reader pauses the input.
 */
function deflateDecoder(): Duplex {
  let inflater: Transform | undefined;
  const decoder: Duplex = new Duplex({
    read() {
      inflater?.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      // An empty chunk says nothing about the format, so the choice waits for the first chunk with data, as undici does.
      if (chunk.length === 0) {
        callback();
        return;
      }
      if (inflater === undefined) {
        inflater =
          ((chunk[0] ?? 0) & 0x0f) === 8 ? createInflate(ZLIB_FLUSH) : createInflateRaw(ZLIB_FLUSH);
        inflater.on('data', (data: Buffer) => {
          if (!decoder.push(data)) inflater?.pause();
        });
        inflater.on('error', (error) => decoder.destroy(error));
      }
      inflater.write(chunk, callback);
    },
    final(callback) {
      // A Duplex ends its readable side only when told to, so the end is pushed here, as a Transform would do.
      if (inflater === undefined) {
        decoder.push(null);
        callback();
        return;
      }
      inflater.once('end', () => {
        decoder.push(null);
        callback();
      });
      inflater.end();
    },
    destroy(error, callback) {
      // The inflater holds a native zlib handle, which an abort must release with the stream.
      inflater?.destroy();
      callback(error);
    },
  });
  return decoder;
}

function decoderFor(coding: string): Duplex {
  if (coding === 'br') return createBrotliDecompress(BROTLI_FLUSH);
  if (coding === 'deflate') return deflateDecoder();
  return createGunzip(ZLIB_FLUSH);
}

/** The reply body with its codings undone, last coding first, as the fetch API does. */
function decodedBody(reply: IncomingMessage, codings: readonly string[]): Readable {
  let body: Readable = reply;
  for (const coding of [...codings].reverse()) {
    const decoder = decoderFor(coding);
    // pipeline passes a failure on to the decoder, so the body fails rather than stalls.
    pipeline(body, decoder, () => undefined);
    body = decoder;
  }
  return body;
}

/** The reply as a Response. A status the Response constructor refuses becomes a bad gateway. */
function toResponse(reply: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(reply.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  // The Response constructor takes only 200 to 599, so any other status becomes a bad gateway.
  const status =
    reply.statusCode !== undefined && reply.statusCode >= 200 && reply.statusCode <= 599
      ? reply.statusCode
      : 502;
  const init = { status, statusText: reply.statusMessage ?? '', headers };
  if (status === 204 || status === 205 || status === 304) {
    reply.resume();
    return new Response(null, init);
  }
  const codings = contentCodings(reply.headers['content-encoding']);
  const decodable = codings.length > 0 && codings.every((coding) => DECODED_CODINGS.has(coding));
  if (decodable) {
    // The body is decoded, so the coding and the compressed length no longer describe it.
    headers.delete('content-encoding');
    headers.delete('content-length');
  }
  const stream: Readable = decodable ? decodedBody(reply, codings) : reply;
  return new Response(
    Readable.toWeb(stream) as unknown as ConstructorParameters<typeof Response>[0],
    init,
  );
}

/** A redirect as the fetch API defines it: a redirect status with a Location header. */
function isRedirect(reply: IncomingMessage): boolean {
  return REDIRECT_STATUSES.has(reply.statusCode ?? 0) && reply.headers.location !== undefined;
}

/**
 * A fetch for public custom endpoints. A host with a pin is reached over HTTPS at its vetted addresses only, with
 * the name kept for SNI and the Host header. Redirects are returned as they are, never followed, unless the caller
 * asks for an error. A host without a pin is reached only when it is this computer or a provider host the registry
 * names, and then only over HTTPS unless it is this computer; any other host is refused.
 */
export function pinnedFetch(
  pins: ReadonlyMap<string, readonly string[]>,
  fallback: PinnedFetch,
  request: HttpsRequest = httpsRequest,
): PinnedFetch {
  return (url, init) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (error) {
      return Promise.reject(error);
    }
    const addresses = pins.get(target.hostname);
    if (addresses === undefined) {
      if (!isUnpinnedHostAllowed(target)) {
        return Promise.reject(
          new Error('This host has no vetted address, so the request was not sent.'),
        );
      }
      if (target.protocol !== 'https:' && !isLoopbackHostname(target.hostname)) {
        return Promise.reject(new Error('A provider host must use HTTPS.'));
      }
      return fallback(url, init);
    }
    if (target.protocol !== 'https:') {
      return Promise.reject(new Error('A public endpoint must use HTTPS.'));
    }
    if (addresses.length === 0 || addresses.some((address) => isRefusedAddress(address))) {
      return Promise.reject(new Error('A pinned address for this endpoint is not public.'));
    }
    // The name without brackets, for the socket; the pin map keeps the URL's own spelling.
    const hostname = target.hostname.replace(/^\[/, '').replace(/\]$/, '');
    return new Promise<Response>((resolve, reject) => {
      let body: Buffer | undefined;
      try {
        body = bodyBytes(init.body);
      } catch (error) {
        reject(error);
        return;
      }
      const headers = headerRecord(init.headers);
      if (headers['accept-encoding'] === undefined)
        headers['accept-encoding'] = 'gzip, deflate, br';
      if (body !== undefined && headers['content-length'] === undefined) {
        headers['content-length'] = String(body.byteLength);
      }
      const signal = init.signal ?? undefined;
      let activeReply: IncomingMessage | undefined;
      const req = request(
        {
          protocol: 'https:',
          hostname,
          port: target.port === '' ? 443 : Number(target.port),
          path: `${target.pathname}${target.search}`,
          method: init.method ?? 'GET',
          headers,
          // The name stays for SNI and the certificate check. An IP address has no name to send.
          ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
          // No pooled socket: every request connects again, to the addresses vetted for that request.
          agent: false,
          lookup: pinnedLookup(addresses) as never,
        },
        (reply) => {
          activeReply = reply;
          // An abort destroys the reply, and nobody may be reading it. Its error must not crash the process.
          reply.on('error', () => undefined);
          try {
            if (init.redirect === 'error' && isRedirect(reply)) {
              reply.resume();
              reject(new TypeError('fetch failed', { cause: new Error('unexpected redirect') }));
              return;
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
        // The caller's reason goes on, as it does with the global fetch. An abort without a reason rejects with an
        // AbortError, and AbortSignal.timeout() rejects with a TimeoutError.
        const onAbort = (): void => {
          const reason =
            signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
          activeReply?.destroy(reason as Error);
          req.destroy(reason as Error);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        req.once('close', () => signal.removeEventListener('abort', onAbort));
        if (signal.aborted) onAbort();
      }
      if (body !== undefined) req.write(body);
      req.end();
    });
  };
}
