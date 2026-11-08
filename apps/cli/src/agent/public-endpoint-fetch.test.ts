import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { PassThrough } from 'node:stream';
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  createPublicEndpointFetch,
  pinnedLookup,
  type HttpsRequest,
} from './public-endpoint-fetch.js';

interface Reply {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string | Buffer;
  /** The body never ends, so that a test can abort it while it is still streaming. */
  readonly hold?: boolean;
  /** The request fails with this error instead of answering. */
  readonly fail?: Error;
}

const OK: Reply = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"ok":true}',
};

/**
 * Stands in for one https request. It records what is written, and answers with a reply or fails with an error. Both
 * happen on a later tick, as a socket delivers them. No socket opens.
 */
class FakeRequest extends EventEmitter {
  readonly written: Buffer[] = [];
  destroyedWith: unknown = undefined;
  private response: PassThrough | undefined = undefined;
  private readonly reply: Reply | undefined;
  private readonly onResponse: (res: IncomingMessage) => void;

  constructor(reply: Reply | undefined, onResponse: (res: IncomingMessage) => void) {
    super();
    this.reply = reply;
    this.onResponse = onResponse;
  }

  write(chunk: Buffer | string): boolean {
    this.written.push(Buffer.from(chunk));
    return true;
  }

  end(chunk?: Buffer | string): void {
    if (chunk !== undefined) this.written.push(Buffer.from(chunk));
    if (this.reply === undefined) return;
    if (this.reply.fail !== undefined) {
      const error = this.reply.fail;
      setImmediate(() => this.emit('error', error));
      return;
    }
    const body = new PassThrough();
    if (this.reply.hold === true) body.write(this.reply.body ?? '');
    else body.end(this.reply.body ?? '');
    Object.assign(body, {
      statusCode: this.reply.status,
      statusMessage: 'OK',
      headers: this.reply.headers ?? {},
    });
    this.response = body;
    setImmediate(() => this.onResponse(body as unknown as IncomingMessage));
  }

  destroy(error?: Error): this {
    this.destroyedWith = error;
    // Node destroys a response that is still unfinished with ECONNRESET 'aborted' when the socket closes.
    if (this.response !== undefined && !this.response.destroyed) {
      this.response.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
    }
    setImmediate(() => this.emit('error', error));
    return this;
  }
}

function fakeHttps(reply?: Reply) {
  const calls: { options: Record<string, unknown>; req: FakeRequest }[] = [];
  const request = vi.fn(
    (options: Record<string, unknown>, onResponse: (res: IncomingMessage) => void) => {
      const req = new FakeRequest(reply, onResponse);
      calls.push({ options, req });
      return req;
    },
  );
  return { request: request as unknown as HttpsRequest, mock: request, calls };
}

/** The code a request fails with, or undefined when the request does not fail. */
async function failureCode(attempt: Promise<unknown>): Promise<string | undefined> {
  try {
    await attempt;
    return undefined;
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown } }).cause;
    return typeof cause?.code === 'string' ? cause.code : 'NOT_A_REFUSAL';
  }
}

describe('createPublicEndpointFetch', () => {
  it('connects only to the addresses vetted for the request and keeps the name for TLS and Host', async () => {
    const https = fakeHttps(OK);
    const resolveHost = vi.fn(async (_hostname: string) => ['93.184.216.34']);
    const send = createPublicEndpointFetch({ resolveHost, request: https.request });
    const body = '{"model":"m"}';

    const response = await send('https://api.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body,
    });

    expect(resolveHost).toHaveBeenCalledWith('api.example.com');
    expect(https.mock).toHaveBeenCalledTimes(1);
    const call = https.calls[0]!;
    expect(call.options).toMatchObject({
      protocol: 'https:',
      hostname: 'api.example.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      servername: 'api.example.com',
      agent: false,
    });
    expect(call.options.headers).toMatchObject({
      authorization: 'Bearer sk-test',
      'content-length': String(Buffer.byteLength(body)),
    });
    expect(Buffer.concat(call.req.written).toString('utf8')).toBe(body);
    const answer = vi.fn();
    (call.options.lookup as LookupFunction)('api.example.com', {}, answer);
    expect(answer).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('resolves the name again before every request, so a changed answer is refused', async () => {
    const https = fakeHttps(OK);
    const resolveHost = vi
      .fn<(hostname: string) => Promise<string[]>>()
      .mockResolvedValueOnce(['93.184.216.34'])
      .mockResolvedValueOnce(['127.0.0.1']);
    const send = createPublicEndpointFetch({ resolveHost, request: https.request });

    await send('https://api.example.com/v1/models');

    expect(await failureCode(send('https://api.example.com/v1/models'))).toBe('ENDPOINT_REFUSED');
    expect(resolveHost).toHaveBeenCalledTimes(2);
    expect(https.mock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a loopback address', ['127.0.0.1']],
    ['a private address', ['10.0.0.7']],
    ['the cloud metadata address', ['169.254.169.254']],
    ['a carrier-grade NAT address', ['100.64.0.1']],
    ['the IPv6 loopback address', ['::1']],
    ['an IPv6 unique-local address', ['fd00::1']],
    ['an IPv6 multicast address', ['ff02::1']],
    ['an IPv4-mapped loopback address in dotted form', ['::ffff:127.0.0.1']],
    ['an IPv4-compatible IPv6 address', ['::7f00:1']],
    ['a NAT64 address that embeds a private IPv4 address', ['64:ff9b::a9fe:a9fe']],
    ['a 6to4 address that embeds a private IPv4 address', ['2002:c0a8:101::1']],
    ['a translated IPv4 address', ['::ffff:0:a00:1']],
    ['an IPv4-mapped private address in dotted form', ['::ffff:10.0.0.7']],
    ['an IPv4-mapped private address in hex form', ['::ffff:a00:7']],
    ['a public IPv6 address with a zone', ['2606:4700:4700::1111%eth0']],
    ['a mix of a public and a private address', ['93.184.216.34', '10.0.0.7']],
  ])('refuses a name whose answer is %s', async (_label, answer) => {
    const https = fakeHttps(OK);
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => answer,
      request: https.request,
    });

    expect(await failureCode(send('https://api.example.com/v1/models'))).toBe('ENDPOINT_REFUSED');
    expect(https.mock).not.toHaveBeenCalled();
  });

  it('refuses a name with no answer', async () => {
    const https = fakeHttps(OK);
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => [],
      request: https.request,
    });

    expect(await failureCode(send('https://api.example.com/v1/models'))).toBe('ENDPOINT_REFUSED');
    expect(https.mock).not.toHaveBeenCalled();
  });

  it('reports a name that does not resolve as a failed fetch that keeps the resolver error', async () => {
    const https = fakeHttps(OK);
    const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), {
      code: 'ENOTFOUND',
    });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => {
        throw notFound;
      },
      request: https.request,
    });

    const error = await send('https://api.example.com/v1/models').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe('fetch failed');
    expect((error as { cause?: unknown }).cause).toBe(notFound);
    expect(https.mock).not.toHaveBeenCalled();
  });

  it.each(['localhost', 'printer.local', 'db.internal', 'metadata.google.internal'])(
    'refuses the internal name %s before any lookup',
    async (name) => {
      const https = fakeHttps(OK);
      const resolveHost = vi.fn(async (_hostname: string): Promise<string[]> => ['93.184.216.34']);
      const send = createPublicEndpointFetch({ resolveHost, request: https.request });

      expect(await failureCode(send(`https://${name}/v1/models`))).toBe('ENDPOINT_REFUSED');
      expect(resolveHost).not.toHaveBeenCalled();
      expect(https.mock).not.toHaveBeenCalled();
    },
  );

  it('refuses an IPv4-compatible IPv6 literal before any lookup', async () => {
    const https = fakeHttps(OK);
    const resolveHost = vi.fn(async (_hostname: string): Promise<string[]> => ['93.184.216.34']);
    const send = createPublicEndpointFetch({ resolveHost, request: https.request });

    expect(await failureCode(send('https://[::127.0.0.1]/v1/models'))).toBe('ENDPOINT_REFUSED');
    expect(resolveHost).not.toHaveBeenCalled();
    expect(https.mock).not.toHaveBeenCalled();
  });

  it('refuses plain HTTP before any lookup', async () => {
    const https = fakeHttps(OK);
    const resolveHost = vi.fn(async (_hostname: string): Promise<string[]> => ['93.184.216.34']);
    const send = createPublicEndpointFetch({ resolveHost, request: https.request });

    expect(await failureCode(send('http://api.example.com/v1/models'))).toBe('ENDPOINT_REFUSED');
    expect(resolveHost).not.toHaveBeenCalled();
    expect(https.mock).not.toHaveBeenCalled();
  });

  it('returns a redirect as it is and does not follow it', async () => {
    const https = fakeHttps({
      status: 302,
      headers: { location: 'https://elsewhere.example/v1/models' },
      body: '',
    });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    const response = await send('https://api.example.com/v1/models');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://elsewhere.example/v1/models');
    expect(https.mock).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect when the caller asks for an error, as the global fetch does', async () => {
    const https = fakeHttps({
      status: 302,
      headers: { location: 'https://elsewhere.example/v1/models' },
      body: '',
    });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    const error = await send('https://api.example.com/v1/models', { redirect: 'error' }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe('fetch failed');
    expect(((error as { cause?: Error }).cause as Error).message).toBe('unexpected redirect');
  });

  it('answers a status outside the HTTP range as a bad gateway instead of failing', async () => {
    const https = fakeHttps({ status: 600, body: '' });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    const response = await send('https://api.example.com/v1/models');

    expect(response.status).toBe(502);
  });

  it('returns a reply that has no body as a response with no body', async () => {
    const https = fakeHttps({ status: 204, body: '' });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    const response = await send('https://api.example.com/v1/models');

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it('refuses a request body that is neither text nor bytes', async () => {
    const https = fakeHttps(OK);
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    await expect(
      send('https://api.example.com/v1/chat/completions', {
        method: 'POST',
        body: new ReadableStream(),
      }),
    ).rejects.toThrow('must be text or bytes');
    expect(https.mock).not.toHaveBeenCalled();
  });

  it('sends a binary body as the bytes it holds, with its length', async () => {
    const https = fakeHttps(OK);
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });
    const bytes = new TextEncoder().encode('{"model":"m"}');

    await send('https://api.example.com/v1/chat/completions', { method: 'POST', body: bytes });

    const call = https.calls[0]!;
    expect(Buffer.concat(call.req.written).equals(Buffer.from(bytes))).toBe(true);
    expect(call.options.headers).toMatchObject({ 'content-length': String(bytes.byteLength) });
  });

  it('refuses a Request object, which would lose its method, headers and body', async () => {
    const https = fakeHttps(OK);
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    await expect(
      send(
        new Request('https://api.example.com/v1/chat/completions', { method: 'POST', body: '{}' }),
      ),
    ).rejects.toThrow('takes a URL');
    expect(https.mock).not.toHaveBeenCalled();
  });

  it('sends nothing and does not look up the name for a signal that is already aborted', async () => {
    const https = fakeHttps(OK);
    const resolveHost = vi.fn(async (_hostname: string): Promise<string[]> => ['93.184.216.34']);
    const send = createPublicEndpointFetch({ resolveHost, request: https.request });
    const controller = new AbortController();
    controller.abort(new DOMException('stopped before the request', 'AbortError'));

    await expect(
      send('https://api.example.com/v1/models', { signal: controller.signal }),
    ).rejects.toThrow('stopped before the request');
    expect(resolveHost).not.toHaveBeenCalled();
    expect(https.mock).not.toHaveBeenCalled();
  });

  it('stops a request whose signal aborts while it waits for the answer', async () => {
    const https = fakeHttps(undefined);
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });
    const controller = new AbortController();

    const pending = send('https://api.example.com/v1/models', { signal: controller.signal });
    await vi.waitFor(() => expect(https.mock).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('stopped by the caller', 'AbortError'));

    await expect(pending).rejects.toThrow('stopped by the caller');
    expect(https.calls[0]!.req.destroyedWith).toBeInstanceOf(DOMException);
  });

  it('stops the request when the signal aborts while the body is still streaming', async () => {
    const https = fakeHttps({ status: 200, body: '{"partial":', hold: true });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });
    const controller = new AbortController();

    const response = await send('https://api.example.com/v1/models', { signal: controller.signal });
    const reader = response.body!.getReader();
    controller.abort(new DOMException('stopped mid-body', 'AbortError'));

    // The partial chunk that arrived before the abort is delivered first; the stream then fails with the abort reason.
    const drain = async (): Promise<void> => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
      }
    };
    await expect(drain()).rejects.toThrow('stopped mid-body');
    expect(https.calls[0]!.req.destroyedWith).toBeInstanceOf(DOMException);
  });

  it('reports a connection failure as a failed fetch that keeps the socket error code', async () => {
    const socketError = Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:443'), {
      code: 'ECONNREFUSED',
    });
    const https = fakeHttps({ status: 200, fail: socketError });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    expect(await failureCode(send('https://api.example.com/v1/models'))).toBe('ECONNREFUSED');
  });

  it('connects an IPv6 literal without brackets and without a server name', async () => {
    const https = fakeHttps(OK);
    const resolveHost = vi.fn(async (_hostname: string) => ['2606:4700:4700::1111']);
    const send = createPublicEndpointFetch({ resolveHost, request: https.request });

    await send('https://[2606:4700:4700::1111]/v1/models');

    expect(resolveHost).toHaveBeenCalledWith('2606:4700:4700::1111');
    const options = https.calls[0]!.options;
    expect(options).toMatchObject({ hostname: '2606:4700:4700::1111' });
    expect(options).not.toHaveProperty('servername');
  });

  it('sends the URL host as the Host header, with the port when the URL names one', async () => {
    const https = fakeHttps(OK);
    const send = createPublicEndpointFetch({
      resolveHost: async (hostname: string): Promise<string[]> =>
        hostname === '2606:4700:4700::1111' ? ['2606:4700:4700::1111'] : ['93.184.216.34'],
      request: https.request,
    });

    await send('https://api.example.com:8443/v1/models');
    await send('https://[2606:4700:4700::1111]/v1/models');

    expect(https.calls[0]!.options.headers).toMatchObject({ host: 'api.example.com:8443' });
    expect(https.calls[1]!.options.headers).toMatchObject({ host: '[2606:4700:4700::1111]' });
  });

  it('asks for the content codings it can decode unless the caller names its own', async () => {
    const https = fakeHttps(OK);
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    await send('https://api.example.com/v1/models');
    await send('https://api.example.com/v1/models', { headers: { 'accept-encoding': 'identity' } });

    expect(https.calls[0]!.options.headers).toMatchObject({
      'accept-encoding': 'gzip, deflate, br',
    });
    expect(https.calls[1]!.options.headers).toMatchObject({ 'accept-encoding': 'identity' });
  });

  it('decodes a gzip reply and drops the coding and length headers', async () => {
    const compressed = gzipSync('{"ok":true}');
    const https = fakeHttps({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': String(compressed.byteLength),
      },
      body: compressed,
    });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    const response = await send('https://api.example.com/v1/models');

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
  });

  it('decodes a brotli reply', async () => {
    const https = fakeHttps({
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'br' },
      body: brotliCompressSync('{"ok":true}'),
    });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    const response = await send('https://api.example.com/v1/models');

    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('decodes a deflate reply in the zlib format', async () => {
    const https = fakeHttps({
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'deflate' },
      body: deflateSync('{"ok":true}'),
    });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    const response = await send('https://api.example.com/v1/models');

    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('decodes a deflate reply that carries raw deflate without the zlib header', async () => {
    const https = fakeHttps({
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'deflate' },
      body: deflateRawSync('{"ok":true}'),
    });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    const response = await send('https://api.example.com/v1/models');

    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('decodes a reply stacked under two codings, last coding undone first', async () => {
    const https = fakeHttps({
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip, br' },
      body: brotliCompressSync(gzipSync('{"ok":true}')),
    });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    const response = await send('https://api.example.com/v1/models');

    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it.each(['x-gzip', 'GZIP', ' gzip '])('decodes a gzip reply named %j', async (coding) => {
    const https = fakeHttps({
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': coding },
      body: gzipSync('{"ok":true}'),
    });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    const response = await send('https://api.example.com/v1/models');

    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('decodes an empty gzip reply to an empty body, as the global fetch does', async () => {
    const https = fakeHttps({
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: '',
    });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    const response = await send('https://api.example.com/v1/models');

    await expect(response.text()).resolves.toBe('');
  });

  it('decodes an empty brotli reply to an empty body, as the global fetch does', async () => {
    const https = fakeHttps({
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'br' },
      body: '',
    });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    const response = await send('https://api.example.com/v1/models');

    await expect(response.text()).resolves.toBe('');
  });

  it('decodes a truncated gzip reply to the part it holds, as the global fetch does', async () => {
    const compressed = gzipSync('{"ok":true}');
    const https = fakeHttps({
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: compressed.subarray(0, 20),
    });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    const response = await send('https://api.example.com/v1/models');

    await expect(response.text()).resolves.toBe('{"ok":tru');
  });

  it('reports the reason the caller gave when a decoded body is aborted', async () => {
    const https = fakeHttps({
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync('{"ok":true}').subarray(0, 12),
      hold: true,
    });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });
    const controller = new AbortController();

    const response = await send('https://api.example.com/v1/models', { signal: controller.signal });
    const reader = response.body!.getReader();
    controller.abort(new DOMException('stopped mid-decode', 'AbortError'));

    await expect(reader.read()).rejects.toThrow('stopped mid-decode');
  });

  it('reports the reason the caller gave when a deflate body is aborted', async () => {
    const https = fakeHttps({
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'deflate' },
      body: deflateSync('{"ok":true}').subarray(0, 8),
      hold: true,
    });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });
    const controller = new AbortController();

    const response = await send('https://api.example.com/v1/models', { signal: controller.signal });
    const reader = response.body!.getReader();
    controller.abort(new DOMException('stopped mid-deflate', 'AbortError'));

    await expect(reader.read()).rejects.toThrow('stopped mid-deflate');
  });

  it('decodes a large deflate reply read slowly, so the decoder waits for the reader', async () => {
    const text = JSON.stringify({ text: 'x'.repeat(300_000) });
    const https = fakeHttps({
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'deflate' },
      body: deflateSync(text),
    });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    const response = await send('https://api.example.com/v1/models');
    const reader = response.body!.getReader();
    let received = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += Buffer.from(chunk.value).toString();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(received).toBe(text);
  });

  it('leaves a reply in a coding it cannot decode as it is', async () => {
    const https = fakeHttps({
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'zstd' },
      body: 'opaque-bytes',
    });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    const response = await send('https://api.example.com/v1/models');

    expect(response.headers.get('content-encoding')).toBe('zstd');
    await expect(response.text()).resolves.toBe('opaque-bytes');
  });

  it('rejects the request when a reply cannot be converted, rather than failing outside it', async () => {
    const https = fakeHttps({ status: 200, headers: { 'x-broken': 'line\nbreak' }, body: '' });
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    await expect(send('https://api.example.com/v1/models')).rejects.toThrow();
  });

  it.each([205, 304])(
    'returns a reply with status %i as a response with no body',
    async (status) => {
      const https = fakeHttps({ status, body: '' });
      const send = createPublicEndpointFetch({
        resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
        request: https.request,
      });

      const response = await send('https://api.example.com/v1/models');

      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
    },
  );

  it('uses the port written in the URL', async () => {
    const https = fakeHttps(OK);
    const send = createPublicEndpointFetch({
      resolveHost: async (): Promise<string[]> => ['93.184.216.34'],
      request: https.request,
    });

    await send('https://api.example.com:8443/v1/models');

    expect(https.calls[0]!.options).toMatchObject({ port: 8443 });
  });
});

describe('pinnedLookup', () => {
  it('answers with the vetted addresses in both lookup shapes', () => {
    const lookup = pinnedLookup(['93.184.216.34', '2606:4700:4700::1111']);

    const single = vi.fn();
    lookup('api.example.com', {}, single);
    expect(single).toHaveBeenCalledWith(null, '93.184.216.34', 4);

    const all = vi.fn();
    lookup('api.example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
  });

  it('answers with the vetted addresses whatever host name is asked for', () => {
    const lookup = pinnedLookup(['93.184.216.34']);
    const answer = vi.fn();

    lookup('some-other.example', {}, answer);

    expect(answer).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it('fails closed when no address is pinned', () => {
    const callback = vi.fn();

    pinnedLookup([])('api.example.com', {}, callback);

    expect(callback.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});
