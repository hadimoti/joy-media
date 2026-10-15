import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionTokenStore } from './session-token-store.js';
import type { SafeStorageLike } from './secrets/electron-secret-store.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function setup(available = true, selectedBackend?: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'joy-session-token-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'session-token.enc');
  const safeStorage: SafeStorageLike = {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => selectedBackend ?? 'gnome_libsecret',
    encryptString: (value) => Buffer.from(Buffer.from(`encrypted:${value}`).toString('base64')),
    decryptString: (value) => {
      const decoded = Buffer.from(value.toString(), 'base64').toString();
      if (!decoded.startsWith('encrypted:')) throw new Error('corrupt');
      return decoded.slice('encrypted:'.length);
    },
  };
  const onWarning = vi.fn();
  return {
    filePath,
    safeStorage,
    onWarning,
    store: createSessionTokenStore(filePath, safeStorage, onWarning),
  };
}

describe('session token store', () => {
  it('persists only encrypted data with restrictive permissions and reads it back', async () => {
    const { filePath, store } = setup();
    await store.set('token-test-redacted');
    expect(await store.get()).toBe('token-test-redacted');
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('token-test-redacted');
    if (process.platform !== 'win32') expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('keeps a token in memory and warns when OS encryption is unavailable', async () => {
    const { filePath, onWarning, store } = setup(false);
    await store.set('token-test-redacted');
    expect(await store.get()).toBe('token-test-redacted');
    expect(fs.existsSync(filePath)).toBe(false);
    expect(onWarning).toHaveBeenCalledOnce();
  });

  it('keeps a token in memory when Linux selects the basic_text backend', async () => {
    const { filePath, onWarning, store } = setup(true, 'basic_text');
    await store.set('token-test-redacted');
    expect(await store.get()).toBe('token-test-redacted');
    expect(fs.existsSync(filePath)).toBe(false);
    expect(onWarning).toHaveBeenCalledOnce();
  });

  it('treats a corrupt encrypted file as empty and clears it', async () => {
    const { filePath, store } = setup();
    fs.writeFileSync(filePath, 'not-valid-ciphertext', { mode: 0o600 });
    expect(await store.get()).toBeUndefined();
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
