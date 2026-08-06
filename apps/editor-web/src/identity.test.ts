import { describe, expect, it } from 'vitest';
import { logoutJoySession, probeJoySession } from './identity.js';
import { setStoredMediaToken } from './media-session.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

describe('probeJoySession', () => {
  it('reports signed-out when no session token is stored (never calls the network)', async () => {
    const state = await probeJoySession(memoryStorage(), async () => {
      throw new Error('should not be called');
    });
    expect(state).toEqual({ kind: 'signed-out' });
  });

  it('reports ready with the contact for a valid stored session', async () => {
    const storage = memoryStorage();
    setStoredMediaToken('token-abc', storage);
    const state = await probeJoySession(storage, async (url) => {
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
    const storage = memoryStorage();
    setStoredMediaToken('token-abc', storage);
    const state = await probeJoySession(storage, async (url) => {
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
    const storage = memoryStorage();
    setStoredMediaToken('token-abc', storage);
    const state = await probeJoySession(
      storage,
      async () => new Response('unauthorized', { status: 401 }),
    );
    expect(state).toEqual({ kind: 'signed-out' });
    expect(storage.getItem('joy-media-session-token')).toBeNull();
  });

  it('reports unavailable on a server error instead of guessing the login state', async () => {
    const storage = memoryStorage();
    setStoredMediaToken('token-abc', storage);
    const state = await probeJoySession(storage, async () =>
      jsonResponse(503, { error: 'unavailable' }),
    );
    expect(state).toEqual({ kind: 'unavailable' });
  });

  it('reports unavailable on network failure instead of guessing the login state', async () => {
    const storage = memoryStorage();
    setStoredMediaToken('token-abc', storage);
    const state = await probeJoySession(storage, async () => {
      throw new TypeError('network down');
    });
    expect(state).toEqual({ kind: 'unavailable' });
  });
});

describe('logoutJoySession', () => {
  it('clears the local token and posts a best-effort remote revoke', async () => {
    const storage = memoryStorage();
    setStoredMediaToken('token-abc', storage);
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    await logoutJoySession(storage, async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: { ok: true } }));
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/v1/auth/logout');
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer token-abc' },
    });
    expect(storage.getItem('joy-media-session-token')).toBeNull();
  });

  it('still clears the local token when the remote revoke fails (opaque/network failure)', async () => {
    const storage = memoryStorage();
    setStoredMediaToken('token-abc', storage);
    await logoutJoySession(storage, async () => {
      throw new TypeError('network down');
    });
    expect(storage.getItem('joy-media-session-token')).toBeNull();
  });

  it('is a no-op when no session token is stored', async () => {
    let called = false;
    await logoutJoySession(memoryStorage(), async () => {
      called = true;
      return new Response();
    });
    expect(called).toBe(false);
  });
});
