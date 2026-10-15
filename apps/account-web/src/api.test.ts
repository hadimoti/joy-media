import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLatestRelease, fetchUserSession, setSessionToken } from './api.js';

function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  return store;
}

function respond(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('account-web api', () => {
  it('#8: a missing release returns null instead of a made-up v1.0.0 download link', async () => {
    stubStorage();
    respond(404, { error: { code: 'RELEASE_NOT_FOUND', message: 'no release' } });
    expect(await fetchLatestRelease('stable')).toBeNull();
  });

  it('#8: a published release is passed through', async () => {
    stubStorage();
    const release = {
      channel: 'stable',
      version: '1.0.1',
      downloadUrl: '/releases/joy-media-windows-x64-v1.0.1.zip',
      sha256: 'a'.repeat(64),
    };
    respond(200, { data: release });
    expect(await fetchLatestRelease('stable')).toEqual(release);
  });

  it.each([500, 502, 503])('#25: a %i keeps the session token', async (status) => {
    const store = stubStorage();
    setSessionToken('session-token');
    respond(status, { error: { message: 'down' } });
    expect(await fetchUserSession()).toBeNull();
    expect(store.get('joy-media-session-token')).toBe('session-token');
  });

  it('#25: a network error keeps the session token', async () => {
    const store = stubStorage();
    setSessionToken('session-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(await fetchUserSession()).toBeNull();
    expect(store.get('joy-media-session-token')).toBe('session-token');
  });

  it.each([401, 403])('#25: a %i clears the session token', async (status) => {
    const store = stubStorage();
    setSessionToken('session-token');
    respond(status, { error: { message: 'expired' } });
    expect(await fetchUserSession()).toBeNull();
    expect(store.has('joy-media-session-token')).toBe(false);
  });
});
