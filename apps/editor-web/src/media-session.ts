/**
 * JOY Media's independent login session (ADR-0017).
 *
 * Desktop tokens live in Electron safeStorage, with a one-time migration from the historical
 * localStorage key below. Browser builds retain localStorage persistence, with memory fallback
 * when browser storage is unavailable.
 */
import {
  clearDesktopSessionToken,
  getDesktopSessionToken,
  isDesktopHost,
  setDesktopSessionToken,
} from './desktop-client.js';

const LEGACY_STORAGE_KEY = 'joy-media-session-token';
const MAX_SESSION_TOKEN_LENGTH = 8192;

/** Dispatched whenever the in-memory or secure session token changes. */
export const MEDIA_SESSION_CHANGED_EVENT = 'joy-media-session-changed';

export interface MediaSessionTokenBackend {
  get(): Promise<string | undefined>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

const memoryBackend = (() => {
  let token: string | undefined;
  return {
    async get() {
      return token;
    },
    async set(value: string) {
      token = value;
    },
    async clear() {
      token = undefined;
    },
  } satisfies MediaSessionTokenBackend;
})();

const browserBackend: MediaSessionTokenBackend = {
  async get() {
    try {
      const token = window.localStorage.getItem(LEGACY_STORAGE_KEY);
      return token !== null && token.length > 0 && token.length <= MAX_SESSION_TOKEN_LENGTH
        ? token
        : undefined;
    } catch {
      return memoryBackend.get();
    }
  },
  async set(token) {
    try {
      window.localStorage.setItem(LEGACY_STORAGE_KEY, token);
    } catch {
      await memoryBackend.set(token);
    }
  },
  async clear() {
    try {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      await memoryBackend.clear();
    }
  },
};

const defaultBackend: MediaSessionTokenBackend = {
  get: () => (isDesktopHost() ? getDesktopSessionToken() : browserBackend.get()),
  set: (token) => (isDesktopHost() ? setDesktopSessionToken(token) : browserBackend.set(token)),
  clear: () => (isDesktopHost() ? clearDesktopSessionToken() : browserBackend.clear()),
};

let backend = defaultBackend;
let cachedToken: string | undefined;
let cacheLoaded = false;
let initialization: Promise<void> | undefined;

/** Injects an in-memory backend for deterministic auth tests. */
export function setMediaSessionTokenBackendForTests(next?: MediaSessionTokenBackend): void {
  backend = next ?? defaultBackend;
  cachedToken = undefined;
  cacheLoaded = false;
  initialization = undefined;
}

export function createMemoryMediaSessionTokenBackend(): MediaSessionTokenBackend {
  let token: string | undefined;
  return {
    async get() {
      return token;
    },
    async set(value) {
      token = value;
    },
    async clear() {
      token = undefined;
    },
  };
}

function removeLegacyTokenAfterMigration(): void {
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Storage may be disabled; secure-store behavior remains available.
  }
}

/** Migrate once, verifying the secure-store read before deleting the old renderer value. */
export function initializeMediaSessionToken(): Promise<void> {
  if (initialization !== undefined) return initialization;
  initialization = (async () => {
    // Only Electron has a protected destination for the legacy value. Browser and test
    // contexts stay memory-only and must never consume or delete localStorage data.
    if (!isDesktopHost()) {
      try {
        cachedToken = await backend.get();
        cacheLoaded = true;
      } catch {
        cachedToken = undefined;
        cacheLoaded = false;
      }
      return;
    }

    let secureToken: string | undefined;
    try {
      secureToken = await backend.get();
    } catch {
      // Keep the legacy value so a transient IPC failure can be retried next startup.
      return;
    }

    let legacyToken: string | null = null;
    try {
      if (typeof window !== 'undefined')
        legacyToken = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    } catch {
      // Browser storage can be disabled; no persistence fallback is used.
    }

    if (secureToken !== undefined) {
      cachedToken = secureToken;
      cacheLoaded = true;
      if (legacyToken !== null) removeLegacyTokenAfterMigration();
      return;
    }

    if (
      legacyToken === null ||
      legacyToken.length === 0 ||
      legacyToken.length > MAX_SESSION_TOKEN_LENGTH
    ) {
      cachedToken = undefined;
      cacheLoaded = true;
      if (legacyToken !== null) removeLegacyTokenAfterMigration();
      return;
    }

    try {
      await backend.set(legacyToken);
      secureToken = await backend.get();
      if (secureToken === legacyToken) {
        cachedToken = secureToken;
        cacheLoaded = true;
        removeLegacyTokenAfterMigration();
        return;
      }
    } catch {
      // Do not discard the old copy unless the destination can read it back.
    }
    cachedToken = secureToken;
    cacheLoaded = secureToken !== undefined;
  })();
  return initialization;
}

export async function getStoredMediaToken(): Promise<string | undefined> {
  await initializeMediaSessionToken();
  if (cacheLoaded) return cachedToken;
  try {
    cachedToken = await backend.get();
    cacheLoaded = true;
    return cachedToken;
  } catch {
    return undefined;
  }
}

export async function setStoredMediaToken(token: string): Promise<void> {
  if (token.length === 0 || token.length > MAX_SESSION_TOKEN_LENGTH) {
    throw new Error('Invalid session token');
  }
  await initializeMediaSessionToken();
  await backend.set(token);
  cachedToken = token;
  cacheLoaded = true;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MEDIA_SESSION_CHANGED_EVENT));
}

export async function clearStoredMediaToken(): Promise<void> {
  await initializeMediaSessionToken();
  await backend.clear();
  cachedToken = undefined;
  cacheLoaded = true;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MEDIA_SESSION_CHANGED_EVENT));
}

import { getRemoteApiBaseUrl, isDesktopHost as isDesktop } from './desktop-client.js';

export type MediaAuthMethod = 'gmail' | 'telegram';

async function requestJson(
  fetchFn: typeof fetch,
  path: string,
  body: unknown,
  token?: string,
): Promise<unknown> {
  const base = getRemoteApiBaseUrl();
  const response = await fetchFn(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);
  if (!response.ok) {
    const message =
      isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string'
        ? parsed.error.message
        : `request failed (${response.status})`;
    throw new Error(message);
  }
  return isRecord(parsed) ? parsed.data : undefined;
}

export async function requestOtp(
  contact: string,
  method: MediaAuthMethod,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const data = await requestJson(fetchFn, '/v1/auth/request-otp', { contact, method });
  return isRecord(data) && typeof data.message === 'string' ? data.message : 'Code requested.';
}

export async function verifyOtp(
  contact: string,
  method: MediaAuthMethod,
  code: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const data = await requestJson(fetchFn, '/v1/auth/verify-otp', { contact, method, code });
  if (!isRecord(data) || typeof data.token !== 'string')
    throw new Error('JOY Media returned an invalid login response');
  await setStoredMediaToken(data.token);
  return data.token;
}

export async function registerDevice(
  displayName?: string,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  const token = await getStoredMediaToken();
  if (!token) return undefined;
  const name =
    displayName || (isDesktop() ? 'JOY Desktop Studio (Windows)' : 'JOY Web Studio (Browser)');
  try {
    return await requestJson(fetchFn, '/v1/devices', { displayName: name }, token);
  } catch {
    // Background registration; do not interrupt interactive auth flow.
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
