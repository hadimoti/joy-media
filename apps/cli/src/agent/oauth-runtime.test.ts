import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeFs from 'node:fs';
import { CHATGPT_TOKEN_URL } from '@joy-media/provider-oauth';
import type { SecretProtector } from '../utils/dpapi-protector.js';
import { createCredentialStore, type OAuthCredential } from '../utils/credential-store.js';
import {
  createOAuthTokenManager,
  OAuthProfileLockTimeoutError,
  oauthProfileLockPath,
  withOAuthProfileLock,
} from './oauth-runtime.js';

// Passes through to the real file system, except that a test can make hard links fail as on FAT or exFAT.
const { linkMode } = vi.hoisted(() => ({ linkMode: { code: undefined as string | undefined } }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    linkSync: (existing: string, path: string) => {
      if (linkMode.code !== undefined) {
        throw Object.assign(new Error(`${linkMode.code}: links unsupported`), {
          code: linkMode.code,
        });
      }
      return actual.linkSync(existing, path);
    },
  };
});

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
const savedEnvironment = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  JOY_MEDIA_HOME: process.env.JOY_MEDIA_HOME,
};

describe('CLI OAuth token manager', () => {
  let home = '';
  let storePath = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'joy-oauth-runtime-'));
    storePath = join(home, '.joy-media', 'credentials.json');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.JOY_MEDIA_HOME = join(home, '.joy-media');
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

  it('refreshes ChatGPT at the inclusive 60-second boundary and stores rotated credentials', async () => {
    const store = createCredentialStore({ path: storePath, protector });
    const profileId = 'chatgpt-profile';
    const expired: OAuthCredential = {
      provider: 'chatgpt',
      tokenRecord: {
        version: 1,
        clientId: 'chatgpt-client-test',
        accountId: 'chatgpt-account-test',
        accessToken: 'chatgpt-old-access-test',
        refreshToken: 'chatgpt-old-refresh-test',
        accessExpiresAt: NOW + 60_000,
      },
    };
    store.save(profileId, expired);
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(CHATGPT_TOKEN_URL);
      expect(new URLSearchParams(String(init.body))).toEqual(
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: 'chatgpt-client-test',
          refresh_token: 'chatgpt-old-refresh-test',
          resource: 'https://api.openai.com/v1',
        }),
      );
      return new Response(
        JSON.stringify({
          access_token: 'chatgpt-new-access-test',
          refresh_token: 'chatgpt-new-refresh-test',
          expires_in: 1800,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const manager = createOAuthTokenManager({ store: () => store, fetch, now: () => NOW });

    const refreshed = await manager.current(profileId, 'chatgpt');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(refreshed).toMatchObject({
      provider: 'chatgpt',
      tokenRecord: {
        accessToken: 'chatgpt-new-access-test',
        refreshToken: 'chatgpt-new-refresh-test',
        accessExpiresAt: NOW + 1_800_000,
      },
    });
    expect(store.read(profileId)).toEqual(refreshed);
  });

  it('leaves the stored token unchanged when refresh fails', async () => {
    const store = createCredentialStore({ path: storePath, protector });
    store.save(KIMI_PROFILE, KIMI_CREDENTIAL);
    const fetch = vi.fn(
      async () =>
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

  it('publishes the owner record with the lock, so a held lock is never seen empty', async () => {
    const path = oauthProfileLockPath(KIMI_PROFILE);
    let recordWhileHeld: unknown;
    await withOAuthProfileLock(
      KIMI_PROFILE,
      async () => {
        recordWhileHeld = JSON.parse(readFileSync(path, 'utf8'));
      },
      { now: () => NOW, isProcessAlive: () => true },
    );
    expect(recordWhileHeld).toEqual({ pid: process.pid, createdAt: NOW });
    expect(existsSync(path)).toBe(false);
  });

  it('does not spin forever when a dead lock owner leaves an empty reclaim guard, and names the guard', async () => {
    const path = oauthProfileLockPath(KIMI_PROFILE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ pid: 987_654_321, createdAt: NOW }));
    writeFileSync(`${path}.reclaim`, '');
    let liveness = 0;

    const failure = await withOAuthProfileLock(KIMI_PROFILE, async () => undefined, {
      timeoutMs: 50,
      retryIntervalMs: 1,
      now: () => NOW,
      isProcessAlive: (pid) => {
        liveness += 1;
        // A spin would call this without limit; the guard turns that into a clear failure instead of a hang.
        if (liveness > 1000) throw new Error('lock loop never reached the deadline');
        return pid === process.pid;
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(OAuthProfileLockTimeoutError);
    expect((failure as OAuthProfileLockTimeoutError).stuckPath).toBe(`${path}.reclaim`);
    expect((failure as Error).message).toContain(`${path}.reclaim`);
  });

  it('reclaims a dead lock when the reclaim guard is left with a dead owner record', async () => {
    const path = oauthProfileLockPath(KIMI_PROFILE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ pid: 987_654_321, createdAt: NOW }));
    writeFileSync(`${path}.reclaim`, JSON.stringify({ pid: 987_654_322, createdAt: NOW }));
    const work = vi.fn(async () => 'acquired');

    await expect(
      withOAuthProfileLock(KIMI_PROFILE, work, {
        timeoutMs: 1_000,
        retryIntervalMs: 1,
        now: () => NOW,
        isProcessAlive: (pid) => pid === process.pid,
      }),
    ).resolves.toBe('acquired');
    expect(existsSync(`${path}.reclaim`)).toBe(false);
  });

  it('does not name a lock that a live writer completes during the stuck check', async () => {
    const path = oauthProfileLockPath(KIMI_PROFILE);
    mkdirSync(dirname(path), { recursive: true });
    // A fallback writer creates the file empty, then writes its owner record shortly after.
    writeFileSync(path, '');
    const completeWrite = setTimeout(() => {
      writeFileSync(path, JSON.stringify({ pid: process.pid, createdAt: NOW }));
    }, 20);

    try {
      const failure = await withOAuthProfileLock(KIMI_PROFILE, async () => undefined, {
        timeoutMs: 4,
        retryIntervalMs: 1,
        now: () => NOW,
        isProcessAlive: () => true,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(OAuthProfileLockTimeoutError);
      expect((failure as OAuthProfileLockTimeoutError).stuckPath).toBeUndefined();
    } finally {
      clearTimeout(completeWrite);
    }
  });

  it('does not report an empty guard as stuck while a live process owns the lock', async () => {
    const path = oauthProfileLockPath(KIMI_PROFILE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ pid: process.pid, createdAt: NOW }));
    writeFileSync(`${path}.reclaim`, '');

    const failure = await withOAuthProfileLock(KIMI_PROFILE, async () => undefined, {
      timeoutMs: 4,
      retryIntervalMs: 1,
      now: () => NOW,
      isProcessAlive: () => true,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(OAuthProfileLockTimeoutError);
    // A live owner is still working, so the timeout must not tell the user to delete anything.
    expect((failure as OAuthProfileLockTimeoutError).stuckPath).toBeUndefined();
    expect((failure as Error).message).toBe(
      'Another JOY Media process is refreshing this sign-in; retry.',
    );
  });

  it('keeps the lock exclusive and leaves no staging file when hard links are unsupported', async () => {
    const path = oauthProfileLockPath(KIMI_PROFILE);
    linkMode.code = 'EPERM';
    try {
      let nestedBlocked = false;
      await withOAuthProfileLock(
        KIMI_PROFILE,
        async () => {
          // A second acquisition while the first is held must still be refused, not silently granted.
          await withOAuthProfileLock(KIMI_PROFILE, async () => undefined, {
            timeoutMs: 4,
            retryIntervalMs: 1,
            now: Date.now,
            isProcessAlive: () => true,
          }).catch((error: unknown) => {
            // Only the lock's own timeout proves exclusion; any other error must fail the test.
            nestedBlocked = error instanceof OAuthProfileLockTimeoutError;
          });
        },
        { now: Date.now, isProcessAlive: () => true },
      );
      expect(nestedBlocked).toBe(true);
    } finally {
      linkMode.code = undefined;
    }
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dirname(path)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('reports a link failure other than an unsupported filesystem instead of hiding it', async () => {
    linkMode.code = 'EIO';
    try {
      await expect(
        withOAuthProfileLock(KIMI_PROFILE, async () => 'acquired', {
          timeoutMs: 50,
          retryIntervalMs: 1,
          now: Date.now,
          isProcessAlive: () => true,
        }),
      ).rejects.toThrow('EIO');
    } finally {
      linkMode.code = undefined;
    }
  });

  it('never reclaims an empty lock file on age alone, and the timeout names that file', async () => {
    const path = oauthProfileLockPath(KIMI_PROFILE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');

    const failure = await withOAuthProfileLock(KIMI_PROFILE, async () => undefined, {
      timeoutMs: 4,
      retryIntervalMs: 1,
      now: Date.now,
      isProcessAlive: () => true,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(OAuthProfileLockTimeoutError);
    expect((failure as OAuthProfileLockTimeoutError).stuckPath).toBe(path);
    expect((failure as Error).message).toContain(path);
    // The empty lock is left in place for the user to inspect and remove; it was not reclaimed.
    expect(existsSync(path)).toBe(true);
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
