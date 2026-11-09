import { EventEmitter } from 'node:events';
import type { request as httpsRequest } from 'node:https';
import { PassThrough, Readable } from 'node:stream';
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { pinnedFetch, pinnedLookup } from './pinned-transport.js';

type FakeResponse = Readable & { statusCode?: number; statusMessage?: string; headers?: object };

/** A stand-in for https.request that records each call and answers with a fixed reply. */
function fakeRequest(reply: {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}) {
  const calls: Array<{ options: Record<string, unknown>; written: string[] }> = [];
  const request = vi.fn(
    (options: Record<string, unknown>, onResponse: (res: FakeResponse) => void) => {
      const call = { options, written: [] as string[] };
      calls.push(call);
      const req = Object.assign(new EventEmitter(), {
        write: (chunk: string) => {
          call.written.push(chunk);
          return true;
        },
        end: () => {
          const bytes = Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body ?? '');
          const res = Readable.from([bytes]) as FakeResponse;
          res.statusCode = reply.status;
          res.statusMessage = 'OK';
          res.headers = reply.headers ?? {};
          onResponse(res);
        },
        destroy: (error?: Error) => {
          req.emit('error', error ?? new Error('destroyed'));
        },
      });
      return req;
    },
  );
  return { request, calls };
}

function asHttps(request: ReturnType<typeof fakeRequest>['request']): typeof httpsRequest {
  return request as unknown as typeof httpsRequest;
}

/** Fetches one pinned public host with the fake reply, and returns the response with the recorded calls. */
async function fetchReply(
  reply: { status: number; headers?: Record<string, string>; body?: string | Buffer },
  init: RequestInit = {},
) {
  const { request, calls } = fakeRequest(reply);
  const fetchImpl = pinnedFetch(
    new Map([['api.example.com', ['93.184.216.34']]]),
    vi.fn(),
    asHttps(request),
  );
  const response = await fetchImpl('https://api.example.com/v1/models', init);
  return { response, calls };
}

describe('pinned lookup (S8 item 4)', () => {
  it('answers the vetted address in both lookup shapes', () => {
    const lookup = pinnedLookup(['93.184.216.34']);
    const single = vi.fn();
    lookup('api.example.com', {}, single);
    expect(single).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    const all = vi.fn();
    lookup('api.example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
  });

  it('refuses when no address is pinned', () => {
    const callback = vi.fn();
    pinnedLookup([])('api.example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('pinned fetch (S8 item 4 and 5)', () => {
  it('connects to the pinned address, keeps the name for SNI and Host, and sends the body', async () => {
    const { request, calls } = fakeRequest({ status: 200, body: '{"ok":true}' });
    const fetchImpl = pinnedFetch(
      new Map([['api.example.com', ['93.184.216.34']]]),
      vi.fn(),
      asHttps(request),
    );
    const response = await fetchImpl('https://api.example.com/v1/models?x=1', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: '{}',
      redirect: 'manual',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    const options = calls[0]?.options ?? {};
    expect(options).toMatchObject({
      hostname: 'api.example.com',
      servername: 'api.example.com',
      path: '/v1/models?x=1',
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-length': '2' },
      agent: false,
    });
    expect(calls[0]?.written.map(String)).toEqual(['{}']);
    const lookup = options.lookup as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void;
    const callback = vi.fn();
    lookup('api.example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it('returns a redirect as it is and does not follow it', async () => {
    const { request, calls } = fakeRequest({
      status: 302,
      headers: { location: 'https://elsewhere.example/v1' },
    });
    const fetchImpl = pinnedFetch(
      new Map([['api.example.com', ['93.184.216.34']]]),
      vi.fn(),
      asHttps(request),
    );
    const response = await fetchImpl('https://api.example.com/v1/chat/completions', {
      method: 'POST',
      redirect: 'manual',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://elsewhere.example/v1');
    expect(calls).toHaveLength(1);
  });

  it('sends a host without a pin to the fallback, and opens no connection of its own', async () => {
    const fallback = vi.fn(async () => new Response('ok'));
    const { request } = fakeRequest({ status: 200 });
    const fetchImpl = pinnedFetch(new Map(), fallback, asHttps(request));
    const url = 'https://api.openai.com/v1/models';
    await fetchImpl(url, {});
    expect(fallback).toHaveBeenCalledWith(url, {});
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a pinned address that is not public', async () => {
    const { request } = fakeRequest({ status: 200 });
    const fetchImpl = pinnedFetch(
      new Map([['api.example.com', ['10.0.0.5']]]),
      vi.fn(),
      asHttps(request),
    );
    await expect(fetchImpl('https://api.example.com/v1/models', {})).rejects.toThrow(/not public/);
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a pinned host reached over plain HTTP', async () => {
    const { request } = fakeRequest({ status: 200 });
    const fetchImpl = pinnedFetch(
      new Map([['api.example.com', ['93.184.216.34']]]),
      vi.fn(),
      asHttps(request),
    );
    await expect(fetchImpl('http://api.example.com/v1/models', {})).rejects.toThrow(/HTTPS/);
    expect(request).not.toHaveBeenCalled();
  });

  it('ends the connection when the caller aborts', async () => {
    const { request } = fakeRequest({ status: 200, body: '' });
    const fetchImpl = pinnedFetch(
      new Map([['api.example.com', ['93.184.216.34']]]),
      vi.fn(),
      asHttps(request),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchImpl('https://api.example.com/v1/models', { signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
  });

  it('refuses a pinned address that carries a zone', async () => {
    const { request } = fakeRequest({ status: 200 });
    const fetchImpl = pinnedFetch(
      new Map([['api.example.com', ['2001:db8::1%eth0']]]),
      vi.fn(),
      asHttps(request),
    );
    await expect(fetchImpl('https://api.example.com/v1/models', {})).rejects.toThrow(/not public/);
    expect(request).not.toHaveBeenCalled();
  });

  it('answers a status outside 200 to 599 as a bad gateway, without throwing', async () => {
    const { request } = fakeRequest({ status: 600, body: 'odd' });
    const fetchImpl = pinnedFetch(
      new Map([['api.example.com', ['93.184.216.34']]]),
      vi.fn(),
      asHttps(request),
    );
    const response = await fetchImpl('https://api.example.com/v1/models', {});
    expect(response.status).toBe(502);
  });

  it('refuses a redirect when the caller asks for an error', async () => {
    const { request } = fakeRequest({
      status: 302,
      headers: { location: 'https://elsewhere.example/v1' },
    });
    const fetchImpl = pinnedFetch(
      new Map([['api.example.com', ['93.184.216.34']]]),
      vi.fn(),
      asHttps(request),
    );
    await expect(
      fetchImpl('https://api.example.com/v1/models', { redirect: 'error' }),
    ).rejects.toThrow(/fetch failed/);
  });

  it('sends a binary body as bytes, with its length', async () => {
    const { request, calls } = fakeRequest({ status: 200 });
    const fetchImpl = pinnedFetch(
      new Map([['api.example.com', ['93.184.216.34']]]),
      vi.fn(),
      asHttps(request),
    );
    await fetchImpl('https://api.example.com/v1/audio', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
    });
    expect(Buffer.from(calls[0]?.written[0] ?? '').equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(calls[0]?.options.headers).toMatchObject({ 'content-length': '3' });
  });

  it('refuses a body that is neither text nor bytes', async () => {
    const { request } = fakeRequest({ status: 200 });
    const fetchImpl = pinnedFetch(
      new Map([['api.example.com', ['93.184.216.34']]]),
      vi.fn(),
      asHttps(request),
    );
    await expect(
      fetchImpl('https://api.example.com/v1/upload', { method: 'POST', body: new Blob(['x']) }),
    ).rejects.toThrow(/text or bytes/);
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses an unpinned host that is neither a provider host nor this computer', async () => {
    const fallback = vi.fn(async () => new Response('ok'));
    const { request } = fakeRequest({ status: 200 });
    const fetchImpl = pinnedFetch(new Map(), fallback, asHttps(request));
    await expect(fetchImpl('https://attacker.example/v1/models', {})).rejects.toThrow(
      /no vetted address/,
    );
    expect(fallback).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('sends this computer, a sign-in host and a provider host to the fallback without a pin', async () => {
    const fallback = vi.fn(async () => new Response('ok'));
    const { request } = fakeRequest({ status: 200 });
    const fetchImpl = pinnedFetch(new Map(), fallback, asHttps(request));
    for (const url of [
      'http://127.0.0.1:1234/v1/models',
      'https://auth.x.ai/.well-known/openid-configuration',
      'https://api.anthropic.com/v1/messages',
    ]) {
      await fetchImpl(url, {});
    }
    expect(fallback).toHaveBeenCalledTimes(3);
    expect(request).not.toHaveBeenCalled();
  });

  it('decodes a gzip reply and drops its coding headers', async () => {
    const { response } = await fetchReply({
      status: 200,
      headers: { 'content-encoding': 'gzip', 'content-length': '24' },
      body: gzipSync('{"ok":true}'),
    });
    expect(await response.text()).toBe('{"ok":true}');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
  });

  it('decodes zlib and raw deflate replies', async () => {
    const zlibReply = await fetchReply({
      status: 200,
      headers: { 'content-encoding': 'deflate' },
      body: deflateSync('{"ok":true}'),
    });
    expect(await zlibReply.response.text()).toBe('{"ok":true}');
    const rawReply = await fetchReply({
      status: 200,
      headers: { 'content-encoding': 'deflate' },
      body: deflateRawSync('{"ok":true}'),
    });
    expect(await rawReply.response.text()).toBe('{"ok":true}');
  });

  it('decodes a brotli reply', async () => {
    const { response } = await fetchReply({
      status: 200,
      headers: { 'content-encoding': 'br' },
      body: brotliCompressSync('{"ok":true}'),
    });
    expect(await response.text()).toBe('{"ok":true}');
  });

  it('passes a reply in a coding it does not decode through as it is', async () => {
    const { response } = await fetchReply({
      status: 200,
      headers: { 'content-encoding': 'zstd' },
      body: 'raw-bytes',
    });
    expect(response.headers.get('content-encoding')).toBe('zstd');
    expect(await response.text()).toBe('raw-bytes');
  });

  it('asks for gzip, deflate and br by default, as the fetch API does', async () => {
    const { calls } = await fetchReply({ status: 200, body: '{}' });
    expect(calls[0]?.options.headers).toMatchObject({ 'accept-encoding': 'gzip, deflate, br' });
  });

  it("ends the connection with the caller's abort reason", async () => {
    const { request } = fakeRequest({ status: 200, body: '' });
    const fetchImpl = pinnedFetch(
      new Map([['api.example.com', ['93.184.216.34']]]),
      vi.fn(),
      asHttps(request),
    );
    const controller = new AbortController();
    controller.abort();
    const failure = await fetchImpl('https://api.example.com/v1/models', {
      signal: controller.signal,
    }).catch((caught: unknown) => caught);
    expect((failure as { name?: unknown }).name).toBe('AbortError');
  });

  it('passes a timeout reason through, so a timeout rejects with a TimeoutError', async () => {
    const { request } = fakeRequest({ status: 200, body: '' });
    const fetchImpl = pinnedFetch(
      new Map([['api.example.com', ['93.184.216.34']]]),
      vi.fn(),
      asHttps(request),
    );
    const signal = AbortSignal.abort(new DOMException('timed out', 'TimeoutError'));
    const failure = await fetchImpl('https://api.example.com/v1/models', { signal }).catch(
      (caught: unknown) => caught,
    );
    expect((failure as { name?: unknown }).name).toBe('TimeoutError');
  });

  it('reports a socket failure as a failed fetch, with the socket error as its cause', async () => {
    const socketError = new Error('socket hang up');
    const failing = vi.fn(() => {
      const req = Object.assign(new EventEmitter(), {
        write: () => true,
        end: () => req.emit('error', socketError),
        destroy: () => req.emit('error', socketError),
      });
      return req;
    });
    const fetchImpl = pinnedFetch(
      new Map([['api.example.com', ['93.184.216.34']]]),
      vi.fn(),
      failing as unknown as typeof httpsRequest,
    );
    const failure = await fetchImpl('https://api.example.com/v1/models', {}).catch(
      (caught: unknown) => caught,
    );
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).message).toBe('fetch failed');
    expect((failure as TypeError).cause).toBe(socketError);
  });

  it("keeps a refused redirect's open reply from raising an unhandled error on abort", async () => {
    // A stream that never ends, so the abort still finds the reply open. The refused redirect leaves it unread.
    let reply: FakeResponse | undefined;
    const redirecting = vi.fn(
      (_options: Record<string, unknown>, onResponse: (res: FakeResponse) => void) => {
        const req = Object.assign(new EventEmitter(), {
          write: () => true,
          end: () => {
            reply = new PassThrough() as unknown as FakeResponse;
            reply.statusCode = 302;
            reply.statusMessage = 'Found';
            reply.headers = { location: 'https://api.example.com/next' };
            onResponse(reply);
          },
          destroy: (error?: Error) => req.emit('error', error ?? new Error('destroyed')),
        });
        return req;
      },
    );
    const controller = new AbortController();
    const fetchImpl = pinnedFetch(
      new Map([['api.example.com', ['93.184.216.34']]]),
      vi.fn(),
      redirecting as unknown as typeof httpsRequest,
    );
    await expect(
      fetchImpl('https://api.example.com/v1/models', {
        redirect: 'error',
        signal: controller.signal,
      }),
    ).rejects.toThrow('fetch failed');
    // Without the reply's error listener, the abort's destroy would raise an unhandled error and fail the run.
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(reply?.destroyed).toBe(true);
  });

  it('removes its abort listener once the request closes', async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const closing = vi.fn(
      (_options: Record<string, unknown>, onResponse: (res: FakeResponse) => void) => {
        const req = Object.assign(new EventEmitter(), {
          write: () => true,
          end: () => {
            const res = Readable.from([Buffer.from('')]) as FakeResponse;
            res.statusCode = 200;
            res.statusMessage = 'OK';
            res.headers = {};
            onResponse(res);
            req.emit('close');
          },
          destroy: (error?: Error) => req.emit('error', error ?? new Error('destroyed')),
        });
        return req;
      },
    );
    const fetchImpl = pinnedFetch(
      new Map([['api.example.com', ['93.184.216.34']]]),
      vi.fn(),
      closing as unknown as typeof httpsRequest,
    );
    await fetchImpl('https://api.example.com/v1/models', { signal: controller.signal });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('refuses a provider host reached over plain HTTP without a pin', async () => {
    const fallback = vi.fn(async () => new Response('ok'));
    const { request } = fakeRequest({ status: 200 });
    const fetchImpl = pinnedFetch(new Map(), fallback, asHttps(request));
    await expect(fetchImpl('http://api.openai.com/v1/models', {})).rejects.toThrow(/HTTPS/);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('sends the xAI host family to the fallback without a pin, as the sign-in code trusts it', async () => {
    const fallback = vi.fn(async () => new Response('ok'));
    const { request } = fakeRequest({ status: 200 });
    const fetchImpl = pinnedFetch(new Map(), fallback, asHttps(request));
    await fetchImpl('https://accounts.x.ai/oauth2/token', {});
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('refuses an xAI host that has a port or credentials unless it is pinned', async () => {
    const fallback = vi.fn(async () => new Response('ok'));
    const { request } = fakeRequest({ status: 200 });
    const fetchImpl = pinnedFetch(new Map(), fallback, asHttps(request));
    await expect(fetchImpl('https://accounts.x.ai:8443/oauth2/token', {})).rejects.toThrow(
      /no vetted address/,
    );
    await expect(fetchImpl('https://user:pass@accounts.x.ai/oauth2/token', {})).rejects.toThrow(
      /no vetted address/,
    );
    expect(fallback).not.toHaveBeenCalled();
  });

  it('sends no server name for a host that is an IP address', async () => {
    const { request, calls } = fakeRequest({ status: 200, body: '' });
    const fetchImpl = pinnedFetch(
      new Map([['93.184.216.34', ['93.184.216.34']]]),
      vi.fn(),
      asHttps(request),
    );
    await fetchImpl('https://93.184.216.34/v1/models', {});
    expect(calls[0]?.options.hostname).toBe('93.184.216.34');
    expect(calls[0]?.options.servername).toBeUndefined();
  });

  it('rejects a URL it cannot parse instead of throwing', async () => {
    const { request } = fakeRequest({ status: 200 });
    const fetchImpl = pinnedFetch(new Map(), vi.fn(), asHttps(request));
    await expect(fetchImpl('not a url', {})).rejects.toThrow();
  });
});
