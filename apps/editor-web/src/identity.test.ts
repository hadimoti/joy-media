import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logoutJoySession, probeJoySession } from './identity.js';
import {
  createMemoryMediaSessionTokenBackend,
  getStoredMediaToken,
  setMediaSessionTokenBackendForTests,
  setStoredMediaToken,
} from './media-session.js';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

beforeEach(() => setMediaSessionTokenBackendForTests(createMemoryMediaSessionTokenBackend()));
afterEach(() => setMediaSessionTokenBackendForTests());

describe('probeJoySession', () => {
  it('reports signed-out when no session token is stored (never calls the network)', async () => {
    const state = await probeJoySession(async () => {
      throw new Error('should not be called');
    });
    expect(state).toEqual({ kind: 'signed-out' });
  });

  it('reports ready with the contact for a valid stored session', async () => {
    await setStoredMediaToken('token-abc');
    const state = await probeJoySession(async (url) => {
      if (String(url).includes('/avatar')) return new Response(null, { status: 404 });
      return jsonResponse(200, {
        data: {
          contact: 'user@example.com',
          method: 'gmail',
          displayName: 'user@example.com',
          avatarAvailable: false,
        },
      });
    });
    expect(state).toEqual({
      kind: 'ready',
      subject: 'user@example.com',
      displayName: 'user@example.com',
      method: 'gmail',
      avatarAvailable: false,
      avatarObjectUrl: undefined,
    });
  });

  it('prefers displayName over numeric telegram contact for the account label', async () => {
    await setStoredMediaToken('token-abc');
    const state = await probeJoySession(async (url) => {
      if (String(url).includes('/avatar')) return new Response(null, { status: 404 });
      return jsonResponse(200, {
        data: {
          contact: '68238523',
          method: 'telegram',
          displayName: '@hadimoti',
          avatarAvailable: false,
        },
      });
    });
    expect(state).toMatchObject({
      kind: 'ready',
      subject: '68238523',
      displayName: '@hadimoti',
      method: 'telegram',
    });
  });

  it('reports signed-out and clears the token on 401 (expired/revoked session)', async () => {
    await setStoredMediaToken('token-abc');
    const state = await probeJoySession(async () => new Response('unauthorized', { status: 401 }));
    expect(state).toEqual({ kind: 'signed-out' });
    expect(await getStoredMediaToken()).toBeUndefined();
  });

  it('reports unavailable on a server error instead of guessing the login state', async () => {
    await setStoredMediaToken('token-abc');
    const state = await probeJoySession(async () => jsonResponse(503, { error: 'unavailable' }));
    expect(state).toEqual({ kind: 'unavailable' });
  });

  it('reports unavailable on network failure instead of guessing the login state', async () => {
    await setStoredMediaToken('token-abc');
    const state = await probeJoySession(async () => {
      throw new TypeError('network down');
    });
    expect(state).toEqual({ kind: 'unavailable' });
  });
});

describe('logoutJoySession', () => {
  it('clears the token and posts a best-effort remote revoke', async () => {
    await setStoredMediaToken('token-abc');
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    await logoutJoySession(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: { ok: true } }));
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/v1/auth/logout');
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer token-abc' },
    });
    expect(await getStoredMediaToken()).toBeUndefined();
  });

  it('still clears the token when the remote revoke fails', async () => {
    await setStoredMediaToken('token-abc');
    await logoutJoySession(async () => {
      throw new TypeError('network down');
    });
    expect(await getStoredMediaToken()).toBeUndefined();
  });

  it('is a no-op when no session token is stored', async () => {
    let called = false;
    await logoutJoySession(async () => {
      called = true;
      return new Response();
    });
    expect(called).toBe(false);
  });
});
