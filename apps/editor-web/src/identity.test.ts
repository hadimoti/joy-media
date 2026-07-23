import { describe, expect, it } from 'vitest';
import { decodeJwtSubject, logoutJoySession, probeJoySession } from './identity.js';

const b64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const token = (claims: Record<string, unknown>) =>
  `${b64url({ alg: 'RS256' })}.${b64url(claims)}.signature`;

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

describe('decodeJwtSubject', () => {
  it('extracts sub for display', () => {
    expect(decodeJwtSubject(token({ sub: 'joy-user-7' }))).toBe('joy-user-7');
  });
  it('returns undefined for garbage', () => {
    expect(decodeJwtSubject('not-a-jwt')).toBeUndefined();
  });
});

describe('probeJoySession', () => {
  it('reports ready with the subject for an entitled session', async () => {
    const state = await probeJoySession(async () =>
      jsonResponse(200, { access_token: token({ sub: '12345' }), expires_in: 300 }),
    );
    expect(state).toEqual({ kind: 'ready', subject: '12345' });
  });

  it('reports no-access with the server message on 403', async () => {
    const state = await probeJoySession(async () =>
      jsonResponse(403, { ok: false, error: 'JOY Media access is not enabled for this account.' }),
    );
    expect(state).toEqual({
      kind: 'no-access',
      message: 'JOY Media access is not enabled for this account.',
    });
  });

  it('reports signed-out on 401', async () => {
    const state = await probeJoySession(async () => new Response('unauthorized', { status: 401 }));
    expect(state).toEqual({ kind: 'signed-out' });
  });

  it('reports unknown on network failure instead of guessing', async () => {
    const state = await probeJoySession(async () => {
      throw new TypeError('network down');
    });
    expect(state).toEqual({ kind: 'unknown' });
  });
});

describe('logoutJoySession', () => {
  it('POSTs the logout route with credentials and survives opaque failures', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    await logoutJoySession(async (url, init) => {
      calls.push({ url: String(url), init });
      throw new TypeError('opaque');
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://joyteam.ir/api/auth/logout');
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      mode: 'no-cors',
      credentials: 'include',
    });
  });
});
