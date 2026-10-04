import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearStoredMediaToken,
  createMemoryMediaSessionTokenBackend,
  getStoredMediaToken,
  initializeMediaSessionToken,
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
  it('migrates the legacy value once, verifies it, and deletes it', async () => {
    const values = new Map([['joy-media-session-token', 'legacy-test-token']]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: (key: string) => values.delete(key),
    } as unknown as Storage;
    let secureToken: string | undefined;
    const backend = {
      get: vi.fn(async () => secureToken),
      set: vi.fn(async (token: string) => {
        secureToken = token;
      }),
      clear: vi.fn(async () => {
        secureToken = undefined;
      }),
    };
    installWindow(storage, { invoke: async () => undefined });
    setMediaSessionTokenBackendForTests(backend);

    await initializeMediaSessionToken();
    await initializeMediaSessionToken();
    expect(secureToken).toBe('legacy-test-token');
    expect(values.has('joy-media-session-token')).toBe(false);
    expect(backend.set).toHaveBeenCalledOnce();
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

  it('uses memory-only storage when no desktop bridge exists', async () => {
    installWindow({
      getItem: () => null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    } as unknown as Storage);
    setMediaSessionTokenBackendForTests();
    await setStoredMediaToken('browser-test-token');
    expect(await getStoredMediaToken()).toBe('browser-test-token');
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
