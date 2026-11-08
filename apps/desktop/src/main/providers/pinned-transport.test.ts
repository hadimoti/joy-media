import { EventEmitter } from 'node:events';
import type { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { pinnedFetch, pinnedLookup } from './pinned-transport.js';

type FakeResponse = Readable & { statusCode?: number; statusMessage?: string; headers?: object };

/** A stand-in for https.request that records each call and answers with a fixed reply. */
function fakeRequest(reply: { status: number; headers?: Record<string, string>; body?: string }) {
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
          const res = Readable.from([Buffer.from(reply.body ?? '')]) as FakeResponse;
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
});
