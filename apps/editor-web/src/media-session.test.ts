import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearStoredMediaToken,
  createMemoryMediaSessionTokenBackend,
  getStoredMediaToken,
  desktopPlatformName,
  initializeMediaSessionToken,
  isMediaSessionPersisted,
  registerDevice,
  resetDeviceRegistrationsForTests,
  setMediaSessionTokenBackendForTests,
  setStoredMediaToken,
} from './media-session.js';

function installWindow(
  storage: Storage,
  joyDesktop?: { invoke: (channel: string, payload?: unknown) => Promise<unknown> },
) {
  vi.stubGlobal('window', {
    localStorage: storage,
    joyDesktop,
    dispatchEvent: vi.fn(),
  });
}

afterEach(() => {
  setMediaSessionTokenBackendForTests();
  vi.unstubAllGlobals();
});

describe('media session token storage', () => {
  it('migrates once through desktop IPC, deletes the legacy value, then uses only IPC', async () => {
    const values = new Map([['joy-media-session-token', 'legacy-test-token']]);
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    } as unknown as Storage;
    let secureToken: string | undefined;
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === 'desktop.media-session.get') return secureToken;
      if (channel === 'desktop.media-session.set') {
        secureToken = payload as string;
        return undefined;
      }
      if (channel === 'desktop.media-session.clear') {
        secureToken = undefined;
        return undefined;
      }
      throw new Error('Unexpected desktop IPC channel');
    });
    installWindow(storage, { invoke });
    setMediaSessionTokenBackendForTests();

    await initializeMediaSessionToken();
    await initializeMediaSessionToken();
    expect(secureToken).toBe('legacy-test-token');
    expect(values.has('joy-media-session-token')).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'desktop.media-session.get',
      'desktop.media-session.set',
      'desktop.media-session.get',
    ]);

    const migrationReads = vi.mocked(storage.getItem).mock.calls.length;
    const migrationDeletes = vi.mocked(storage.removeItem).mock.calls.length;
    expect(await getStoredMediaToken()).toBe('legacy-test-token');
    await setStoredMediaToken('new-session-test-token');
    await clearStoredMediaToken();
    expect(vi.mocked(storage.getItem)).toHaveBeenCalledTimes(migrationReads);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(vi.mocked(storage.removeItem)).toHaveBeenCalledTimes(migrationDeletes);
    expect(invoke.mock.calls.slice(3).map(([channel]) => channel)).toEqual([
      'desktop.media-session.set',
      'desktop.media-session.clear',
    ]);
  });

  it('keeps the legacy copy when the desktop has no keyring and says the session is not persisted', async () => {
    const values = new Map([['joy-media-session-token', 'legacy-test-token']]);
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    } as unknown as Storage;
    let memoryToken: string | undefined;
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === 'desktop.media-session.get') return memoryToken;
      if (channel === 'desktop.media-session.set') {
        memoryToken = payload as string;
        return { persisted: false, reason: 'secure-storage-unavailable' };
      }
      return undefined;
    });
    installWindow(storage, { invoke });
    setMediaSessionTokenBackendForTests();

    await initializeMediaSessionToken();

    expect(await getStoredMediaToken()).toBe('legacy-test-token');
    expect(values.get('joy-media-session-token')).toBe('legacy-test-token');
    expect(isMediaSessionPersisted()).toBe(false);
  });

  it('deletes a legacy copy when a secure token already exists', async () => {
    const values = new Map([['joy-media-session-token', 'old-test-token']]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    } as unknown as Storage;
    installWindow(storage, { invoke: async () => undefined });
    const backend = createMemoryMediaSessionTokenBackend();
    await backend.set('secure-test-token');
    setMediaSessionTokenBackendForTests(backend);

    await initializeMediaSessionToken();

    expect(await getStoredMediaToken()).toBe('secure-test-token');
    expect(values.has('joy-media-session-token')).toBe(false);
  });

  it('keeps the legacy copy if migration cannot verify the destination', async () => {
    const values = new Map([['joy-media-session-token', 'legacy-test-token']]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    } as unknown as Storage;
    installWindow(storage, { invoke: async () => undefined });
    setMediaSessionTokenBackendForTests({
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    });

    await initializeMediaSessionToken();

    expect(values.has('joy-media-session-token')).toBe(true);
  });

  it('does not migrate from localStorage in browser fallback mode', async () => {
    const values = new Map([['joy-media-session-token', 'legacy-test-token']]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: vi.fn((key: string) => values.delete(key)),
    } as unknown as Storage;
    installWindow(storage);
    setMediaSessionTokenBackendForTests();

    await initializeMediaSessionToken();

    expect(values.has('joy-media-session-token')).toBe(true);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('keeps tokens in the injected memory backend and never writes localStorage', async () => {
    const values = new Map([['joy-media-session-token', 'legacy-test-token']]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: vi.fn(),
      removeItem: vi.fn((key: string) => values.delete(key)),
    } as unknown as Storage;
    installWindow(storage, { invoke: async () => undefined });
    setMediaSessionTokenBackendForTests(createMemoryMediaSessionTokenBackend());
    await setStoredMediaToken('session-test-redacted');
    expect(await getStoredMediaToken()).toBe('session-test-redacted');
    await clearStoredMediaToken();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(values.has('joy-media-session-token')).toBe(false);
  });

  it('uses localStorage fallback when no desktop bridge exists', async () => {
    const values = new Map<string, string>();
    installWindow({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    } as unknown as Storage);
    setMediaSessionTokenBackendForTests();
    await setStoredMediaToken('browser-test-token');
    expect(await getStoredMediaToken()).toBe('browser-test-token');
    expect(values.get('joy-media-session-token')).toBe('browser-test-token');
    setMediaSessionTokenBackendForTests();
    expect(await getStoredMediaToken()).toBe('browser-test-token');
    await clearStoredMediaToken();
    expect(values.has('joy-media-session-token')).toBe(false);
  });
});

describe('session token localStorage guard', () => {
  it('keeps the legacy session key confined to the migration module', () => {
    const sourceRoot = path.resolve(import.meta.dirname);
    const sourceFiles: string[] = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(entryPath);
        else if (/\.(tsx?|jsx?)$/.test(entry.name) && !/\.test\./.test(entry.name))
          sourceFiles.push(entryPath);
      }
    };
    visit(sourceRoot);
    const references = sourceFiles.filter((file) =>
      fs.readFileSync(file, 'utf8').includes('joy-media-session-token'),
    );
    expect(references.map((file) => path.basename(file))).toEqual(['media-session.ts']);
  });
});

describe('#10 device registration', () => {
  it('registers once per session token even when sign-in paths fire together', async () => {
    resetDeviceRegistrationsForTests();
    setMediaSessionTokenBackendForTests(createMemoryMediaSessionTokenBackend());
    await setStoredMediaToken('device-test-token');
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ data: { id: 'd1' } }), { status: 201 }),
    );
    await Promise.all([
      registerDevice(undefined, fetchFn as unknown as typeof fetch),
      registerDevice(undefined, fetchFn as unknown as typeof fetch),
      registerDevice(undefined, fetchFn as unknown as typeof fetch),
      registerDevice(undefined, fetchFn as unknown as typeof fetch),
    ]);
    await registerDevice(undefined, fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed registration', async () => {
    resetDeviceRegistrationsForTests();
    setMediaSessionTokenBackendForTests(createMemoryMediaSessionTokenBackend());
    await setStoredMediaToken('device-retry-token');
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(new Response(JSON.stringify({ data: { id: 'd2' } }), { status: 201 }));
    await registerDevice(undefined, fetchFn as unknown as typeof fetch);
    await registerDevice(undefined, fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['Win32', 'Windows'],
    ['Windows', 'Windows'],
    ['Linux x86_64', 'Linux'],
    ['MacIntel', 'macOS'],
    ['', 'Desktop'],
  ])('names platform %s as %s', (platform, name) => {
    expect(desktopPlatformName(platform)).toBe(name);
  });
});
