import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ACCESS_TOKEN_REFRESH_MARGIN_MS,
  createChatGptTokenKeeper,
  createKimiTokenKeeper,
  createXaiTokenKeeper,
  KIMI_CODE_REFRESH_MARGIN_MS,
  XAI_OAUTH_REFRESH_MARGIN_MS,
  type FetchLike,
} from '@joy-media/provider-oauth';
import { getJoyMediaDir, openCredentialStore } from '../utils/config.js';
import type { CredentialStore, OAuthCredential } from '../utils/credential-store.js';

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_INTERVAL_MS = 100;

export class OAuthProfileLockTimeoutError extends Error {
  constructor() {
    super('Another JOY Media process is refreshing this sign-in; retry.');
    this.name = 'OAuthProfileLockTimeoutError';
  }
}

export class OAuthProfileCredentialError extends Error {
  constructor() {
    super('The OAuth credential is unavailable or changed while it was being refreshed.');
    this.name = 'OAuthProfileCredentialError';
  }
}

export class OAuthRefreshFailedError extends Error {
  constructor(profileId: string, provider: OAuthCredential['provider']) {
    super(
      `OAuth refresh failed for ${profileId}. No provider request was sent. Reauthorize with: joy-media agent provider add ${profileId} --provider ${provider} --oauth.`,
    );
    this.name = 'OAuthRefreshFailedError';
  }
}

export interface OAuthProfileLockOptions {
  readonly timeoutMs?: number;
  readonly retryIntervalMs?: number;
  readonly now?: () => number;
  readonly isProcessAlive?: (pid: number) => boolean;
}

/** Serializes refresh-token rotation across CLI processes (D22 step 3 design §6). */
export async function withOAuthProfileLock<T>(
  profileId: string,
  work: () => Promise<T>,
  options: OAuthProfileLockOptions = {},
): Promise<T> {
  const path = oauthProfileLockPath(profileId);
  mkdirSync(dirname(path), { recursive: true });
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const retryIntervalMs = options.retryIntervalMs ?? LOCK_RETRY_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: now() }));
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        rmSync(path, { force: true });
      }
      if (!isAlreadyExists(error)) throw error;
    }

    if (descriptor !== undefined) {
      closeSync(descriptor);
      try {
        return await work();
      } finally {
        rmSync(path, { force: true });
      }
    }

    const owner = readLockOwner(path);
    if (owner !== undefined && !isProcessAlive(owner.pid)) {
      reclaimDeadLock(path, owner, now, isProcessAlive);
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new OAuthProfileLockTimeoutError();
    await wait(Math.min(retryIntervalMs, remaining));
  }
}

export function oauthProfileLockPath(profileId: string): string {
  const profileHash = createHash('sha256').update(profileId, 'utf8').digest('hex');
  return join(getJoyMediaDir(), `oauth-refresh-${profileHash}.lock`);
}

export interface OAuthTokenManagerDependencies {
  readonly store: CredentialStore | (() => CredentialStore);
  readonly fetch: FetchLike;
  readonly now: () => number;
  readonly lockOptions?: OAuthProfileLockOptions;
}

export interface OAuthTokenManager {
  current(profileId: string, expectedProvider: OAuthCredential['provider']): Promise<OAuthCredential>;
}

export function createOAuthTokenManager(
  dependencies: OAuthTokenManagerDependencies,
): OAuthTokenManager {
  const getStore =
    typeof dependencies.store === 'function'
      ? dependencies.store
      : () => dependencies.store as CredentialStore;
  const refreshing = new Map<string, Promise<OAuthCredential>>();

  const save = async <Provider extends OAuthCredential['provider'], Record>(
    profileId: string,
    provider: Provider,
    handleId: string,
    tokenRecord: Record,
  ): Promise<void> => {
    const store = getStore();
    const current = store.read(profileId);
    if (
      current === undefined ||
      !('provider' in current) ||
      current.provider !== provider ||
      recordHandle(current) !== handleId
    ) {
      throw new OAuthProfileCredentialError();
    }
    store.save(profileId, { provider, tokenRecord } as OAuthCredential);
  };

  const chatGptKeeper = createChatGptTokenKeeper({
    fetch: dependencies.fetch,
    now: dependencies.now,
    save: (profileId, handleId, tokenRecord) =>
      save(profileId, 'chatgpt', handleId, tokenRecord),
  });
  const kimiKeeper = createKimiTokenKeeper({
    fetch: dependencies.fetch,
    now: dependencies.now,
    save: (profileId, handleId, tokenRecord) => save(profileId, 'kimi', handleId, tokenRecord),
  });
  const xaiKeeper = createXaiTokenKeeper({
    fetch: dependencies.fetch,
    now: dependencies.now,
    save: (profileId, handleId, tokenRecord) => save(profileId, 'xai', handleId, tokenRecord),
  });

  async function refreshUnderLock(
    profileId: string,
    expectedProvider: OAuthCredential['provider'],
  ): Promise<OAuthCredential> {
    return withOAuthProfileLock(
      profileId,
      async () => {
        const latest = getStore().read(profileId);
        if (
          latest === undefined ||
          !('provider' in latest) ||
          latest.provider !== expectedProvider
        ) {
          throw new OAuthProfileCredentialError();
        }
        const handleId = recordHandle(latest);
        switch (latest.provider) {
          case 'chatgpt':
            return {
              provider: 'chatgpt',
              tokenRecord: await chatGptKeeper.current(
                profileId,
                handleId,
                latest.tokenRecord,
              ),
            };
          case 'kimi':
            return {
              provider: 'kimi',
              tokenRecord: await kimiKeeper.current(profileId, handleId, latest.tokenRecord),
            };
          case 'xai':
            return {
              provider: 'xai',
              tokenRecord: await xaiKeeper.current(profileId, handleId, latest.tokenRecord),
            };
        }
      },
      dependencies.lockOptions,
    );
  }

  return {
    async current(profileId, expectedProvider) {
      const credential = getStore().read(profileId);
      if (
        credential === undefined ||
        !('provider' in credential) ||
        credential.provider !== expectedProvider
      ) {
        throw new OAuthProfileCredentialError();
      }
      if (credential.tokenRecord.accessExpiresAt - dependencies.now() > refreshMargin(credential)) {
        return credential;
      }
      const existing = refreshing.get(profileId);
      if (existing !== undefined) return existing;
      const pending = refreshUnderLock(profileId, expectedProvider).finally(() => {
        refreshing.delete(profileId);
      });
      refreshing.set(profileId, pending);
      return pending;
    },
  };
}

let defaultTokenManager: OAuthTokenManager | undefined;

export function getDefaultOAuthTokenManager(): OAuthTokenManager {
  defaultTokenManager ??= createOAuthTokenManager({
    store: openCredentialStore,
    fetch: (url, init) => globalThis.fetch(url, init),
    now: Date.now,
  });
  return defaultTokenManager;
}

function refreshMargin(credential: OAuthCredential): number {
  switch (credential.provider) {
    case 'chatgpt':
      return ACCESS_TOKEN_REFRESH_MARGIN_MS;
    case 'kimi':
      return KIMI_CODE_REFRESH_MARGIN_MS;
    case 'xai':
      return XAI_OAUTH_REFRESH_MARGIN_MS;
  }
}

function recordHandle(credential: OAuthCredential): string {
  return createHash('sha256')
    .update(JSON.stringify(credential), 'utf8')
    .digest('hex');
}

interface LockOwner {
  readonly pid: number;
  readonly createdAt: number;
}

function readLockOwner(path: string): LockOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      Number.isInteger((parsed as { pid?: unknown }).pid) &&
      typeof (parsed as { createdAt?: unknown }).createdAt === 'number'
    ) {
      return {
        pid: (parsed as { pid: number }).pid,
        createdAt: (parsed as { createdAt: number }).createdAt,
      };
    }
  } catch {
    // A malformed lock has no recorded process we can prove is dead, so it is never reclaimed here.
  }
  return undefined;
}

function reclaimDeadLock(
  path: string,
  expected: LockOwner,
  now: () => number,
  isProcessAlive: (pid: number) => boolean,
): void {
  const reclaimPath = `${path}.reclaim`;
  let descriptor: number;
  try {
    descriptor = openSync(reclaimPath, 'wx', 0o600);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const reclaimOwner = readLockOwner(reclaimPath);
    if (reclaimOwner !== undefined && !isProcessAlive(reclaimOwner.pid)) {
      rmSync(reclaimPath, { force: true });
    }
    return;
  }
  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: now() }));
  } catch (error) {
    closeSync(descriptor);
    rmSync(reclaimPath, { force: true });
    throw error;
  }
  closeSync(descriptor);
  try {
    const current = readLockOwner(path);
    if (
      current !== undefined &&
      current.pid === expected.pid &&
      current.createdAt === expected.createdAt &&
      !isProcessAlive(current.pid)
    ) {
      rmSync(path, { force: true });
    }
  } finally {
    rmSync(reclaimPath, { force: true });
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
