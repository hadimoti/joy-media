// FT2 review MUST1: with no OS keyring a plaintext token must never outlive the run.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearStoredMediaToken,
  getStoredMediaToken,
  initializeMediaSessionToken,
  isMediaSessionPersisted,
  setMediaSessionTokenBackendForTests,
  setStoredMediaToken,
} from './media-session.js';

const KEY = 'joy-media-session-token';

/** A desktop host without a keyring: the main process keeps the token in memory only. */
function noKeyringDesktop(values: Map<string, string>) {
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } as unknown as Storage;
  let memory: string | undefined;
  const invoke = vi.fn(async (channel: string, payload?: unknown) => {
    if (channel === 'desktop.media-session.get') return memory;
    if (channel === 'desktop.media-session.set') {
      memory = payload as string;
      return { persisted: false, reason: 'secure-storage-unavailable' };
    }
    if (channel === 'desktop.media-session.clear') memory = undefined;
    return undefined;
  });
  const dispatchEvent = vi.fn();
  vi.stubGlobal('window', {
    localStorage: storage,
    joyDesktop: { invoke },
    dispatchEvent,
  });
  setMediaSessionTokenBackendForTests();
  return { invoke, dispatchEvent, restartMainProcess: () => (memory = undefined) };
}

afterEach(() => {
  setMediaSessionTokenBackendForTests();
  vi.unstubAllGlobals();
});

describe('MUST1: no keyring, no plaintext token', () => {
  it('migration moves a legacy token into memory and deletes the plaintext copy', async () => {
    const values = new Map([[KEY, 'legacy-token']]);
    noKeyringDesktop(values);
    await initializeMediaSessionToken();
    expect(await getStoredMediaToken()).toBe('legacy-token');
    expect(values.has(KEY)).toBe(false);
    expect(isMediaSessionPersisted()).toBe(false);
  });

  it('sign-out removes a leftover plaintext copy', async () => {
    const values = new Map<string, string>();
    noKeyringDesktop(values);
    await setStoredMediaToken('session-a');
    values.set(KEY, 'session-a'); // e.g. written by an older build
    await clearStoredMediaToken();
    expect(values.has(KEY)).toBe(false);
    expect(await getStoredMediaToken()).toBeUndefined();
  });

  it('restart: after the run ends nothing signs the user back in', async () => {
    const values = new Map([[KEY, 'legacy-token']]);
    const host = noKeyringDesktop(values);
    await initializeMediaSessionToken();
    host.restartMainProcess();
    setMediaSessionTokenBackendForTests(); // fresh renderer
    await initializeMediaSessionToken();
    expect(await getStoredMediaToken()).toBeUndefined();
    expect(values.has(KEY)).toBe(false);
  });

  it('account switch: a new sign-in removes the old account copy and wins', async () => {
    const values = new Map([[KEY, 'account-a']]);
    noKeyringDesktop(values);
    await initializeMediaSessionToken();
    values.set(KEY, 'account-a');
    await setStoredMediaToken('account-b');
    expect(values.has(KEY)).toBe(false);
    expect(await getStoredMediaToken()).toBe('account-b');
  });

  it('migration fires a session-changed event so the keyring notice shows', async () => {
    const host = noKeyringDesktop(new Map([[KEY, 'legacy-token']]));
    await initializeMediaSessionToken();
    expect(host.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'joy-media-session-changed' }),
    );
  });

  it('sign-out removes the plaintext copy even when the desktop clear throws', async () => {
    const values = new Map<string, string>();
    const host = noKeyringDesktop(values);
    await setStoredMediaToken('session-a');
    values.set(KEY, 'session-a');
    host.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'desktop.media-session.clear') throw new Error('ipc down');
      return undefined;
    });
    await expect(clearStoredMediaToken()).rejects.toThrow('ipc down');
    expect(values.has(KEY)).toBe(false);
    expect(await getStoredMediaToken()).toBeUndefined();
  });
});
