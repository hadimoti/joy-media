import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretProtector } from '../utils/dpapi-protector.js';
import {
  createCredentialStore,
  type OAuthCredential,
} from '../utils/credential-store.js';
import {
  createOAuthTokenManager,
  oauthProfileLockPath,
  withOAuthProfileLock,
} from './oauth-runtime.js';

const NOW = Date.UTC(2026, 9, 31, 0, 0, 0);
const KIMI_PROFILE = 'kimi-profile';
const KIMI_CREDENTIAL: OAuthCredential = {
  provider: 'kimi',
  tokenRecord: {
    version: 1,
    clientId: 'kimi-client-test',
    accessToken: 'kimi-old-access-test',
    refreshToken: 'kimi-old-refresh-test',
    accessExpiresAt: NOW + 60_000,
    scope: 'kimi-code',
  },
};
const protector: SecretProtector = {
  name: 'test-base64',
  protect: (plain) => Buffer.from(plain, 'utf8').toString('base64'),
  unprotect: (ciphertext) => Buffer.from(ciphertext, 'base64').toString('utf8'),
};
const savedEnvironment = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

describe('CLI OAuth token manager', () => {
  let home = '';
  let storePath = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'joy-oauth-runtime-'));
    storePath = join(home, '.joy-media', 'credentials.json');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [name, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('refreshes once across two store and keeper instances, then stores the rotated record', async () => {
    const firstStore = createCredentialStore({ path: storePath, protector });
    const secondStore = createCredentialStore({ path: storePath, protector });
    firstStore.save(KIMI_PROFILE, KIMI_CREDENTIAL);
    let finishRefresh: ((response: Response) => void) | undefined;
    const refreshResponse = new Promise<Response>((resolve) => {
      finishRefresh = resolve;
    });
    const fetch = vi.fn(async () => refreshResponse);
    const firstManager = createOAuthTokenManager({
      store: () => firstStore,
      fetch,
      now: () => NOW,
    });
    const secondManager = createOAuthTokenManager({
      store: () => secondStore,
      fetch,
      now: () => NOW,
    });

    const first = firstManager.current(KIMI_PROFILE, 'kimi');
    const second = secondManager.current(KIMI_PROFILE, 'kimi');
    await new Promise((resolve) => setTimeout(resolve, 10));
    finishRefresh?.(
      new Response(
        JSON.stringify({
          access_token: 'kimi-new-access-test',
          refresh_token: 'kimi-new-refresh-test',
          expires_in: 1800,
          scope: 'kimi-code',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(firstResult.tokenRecord.accessToken).toBe('kimi-new-access-test');
    expect(secondResult.tokenRecord.refreshToken).toBe('kimi-new-refresh-test');
    expect(secondStore.read(KIMI_PROFILE)).toEqual(firstResult);
  });

  it('does not refresh a token just outside the shared 60-second margin', async () => {
    const store = createCredentialStore({ path: storePath, protector });
    const fresh = {
      ...KIMI_CREDENTIAL,
      tokenRecord: { ...KIMI_CREDENTIAL.tokenRecord, accessExpiresAt: NOW + 60_001 },
    } satisfies OAuthCredential;
    store.save(KIMI_PROFILE, fresh);
    const fetch = vi.fn(async () => {
      throw new Error('A fresh OAuth token must not refresh.');
    });
    const manager = createOAuthTokenManager({ store: () => store, fetch, now: () => NOW });

    await expect(manager.current(KIMI_PROFILE, 'kimi')).resolves.toEqual(fresh);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves the stored token unchanged when refresh fails', async () => {
    const store = createCredentialStore({ path: storePath, protector });
    store.save(KIMI_PROFILE, KIMI_CREDENTIAL);
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', secret: 'provider-body-secret' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const manager = createOAuthTokenManager({ store: () => store, fetch, now: () => NOW });

    await expect(manager.current(KIMI_PROFILE, 'kimi')).rejects.toThrow();
    expect(store.read(KIMI_PROFILE)).toEqual(KIMI_CREDENTIAL);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reclaims a lock only after its recorded process is confirmed dead', async () => {
    const path = oauthProfileLockPath(KIMI_PROFILE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ pid: 987_654_321, createdAt: NOW }));
    const work = vi.fn(async () => 'acquired');

    await expect(
      withOAuthProfileLock(KIMI_PROFILE, work, {
        now: () => NOW,
        isProcessAlive: (pid) => pid === process.pid,
      }),
    ).resolves.toBe('acquired');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('times out while another live process owns the profile lock', async () => {
    const path = oauthProfileLockPath(KIMI_PROFILE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ pid: process.pid, createdAt: NOW }));

    await expect(
      withOAuthProfileLock(KIMI_PROFILE, async () => undefined, {
        timeoutMs: 4,
        retryIntervalMs: 1,
        now: () => NOW,
        isProcessAlive: () => true,
      }),
    ).rejects.toThrow('Another JOY Media process is refreshing this sign-in; retry.');
  });
});
