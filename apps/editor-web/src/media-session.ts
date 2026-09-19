/**
 * JOY Media's own independent login session (ADR-0017). Replaces the retired
 * joyteam.ir JWT-assertion bridge: the session token below comes from this
 * app's own /v1/auth/request-otp + /v1/auth/verify-otp, is issued against
 * JOY Media's own allow-list, and is sent as a Bearer token on every API call.
 */

const STORAGE_KEY = 'joy-media-session-token';

/** Dispatched on `window` whenever the local session token is set or cleared. */
export const MEDIA_SESSION_CHANGED_EVENT = 'joy-media-session-changed';

export interface MediaSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function notifyMediaSessionChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(MEDIA_SESSION_CHANGED_EVENT));
}

export function getStoredMediaToken(storage: MediaSessionStorage): string | undefined {
  try {
    return storage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setStoredMediaToken(token: string, storage: MediaSessionStorage): void {
  try {
    storage.setItem(STORAGE_KEY, token);
  } catch {
    /* storage may be unavailable (private browsing); session just won't persist */
  }
  notifyMediaSessionChanged();
}

export function clearStoredMediaToken(storage: MediaSessionStorage): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
  notifyMediaSessionChanged();
}

import { getRemoteApiBaseUrl, isDesktopHost } from './desktop-client.js';

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
  storage: MediaSessionStorage,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const data = await requestJson(fetchFn, '/v1/auth/verify-otp', { contact, method, code });
  if (!isRecord(data) || typeof data.token !== 'string')
    throw new Error('JOY Media returned an invalid login response');
  setStoredMediaToken(data.token, storage);
  return data.token;
}

export async function registerDevice(
  displayName?: string,
  storage: MediaSessionStorage = typeof window !== 'undefined'
    ? window.localStorage
    : ({} as MediaSessionStorage),
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  const token = getStoredMediaToken(storage);
  if (!token) return undefined;
  const name =
    displayName || (isDesktopHost() ? 'JOY Desktop Studio (Windows)' : 'JOY Web Studio (Browser)');
  try {
    return await requestJson(fetchFn, '/v1/devices', { displayName: name }, token);
  } catch {
    // Background registration; do not interrupt interactive auth flow
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
