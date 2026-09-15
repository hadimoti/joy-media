import { describe, expect, it } from 'vitest';
import { createElectronSecretStore } from './electron-secret-store.js';
import type { SafeStorageLike } from './electron-secret-store.js';
import { LocalDatabase } from '../../store/local-database.js';

/** A fake `safeStorage`: real base64-wraps the value with a fixed prefix so encryption is
 * observably happening (tests can assert the DB never sees plaintext) without depending on a
 * real OS keychain. */
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText) => Buffer.from(`enc:${plainText}`, 'utf8'),
    decryptString: (encrypted) => encrypted.toString('utf8').replace(/^enc:/, ''),
  };
}

function setup(available = true) {
  const database = new LocalDatabase({ filePath: ':memory:' });
  const store = createElectronSecretStore(database, fakeSafeStorage(available));
  return { database, store };
}

describe('createElectronSecretStore', () => {
  it('stores and retrieves secrets', async () => {
    const { store } = setup();
    await store.set('handle-1', 'sk-my-real-key');
    expect(await store.get('handle-1')).toBe('sk-my-real-key');
  });

  it('never persists the plaintext value — only ciphertext reaches the database', async () => {
    const { database, store } = setup();
    await store.set('handle-1', 'sk-my-real-key');
    const stored = database.getSecretCiphertext('handle-1');
    expect(stored).toBeDefined();
    expect(stored).not.toContain('sk-my-real-key');
  });

  it('returns null for a non-existent secret', async () => {
    const { store } = setup();
    expect(await store.get('missing')).toBeNull();
  });

  it('deletes a secret', async () => {
    const { store } = setup();
    await store.set('handle-1', 'sk-my-real-key');
    await store.delete('handle-1');
    expect(await store.get('handle-1')).toBeNull();
  });

  it('overwrites an existing secret (key rotation)', async () => {
    const { store } = setup();
    await store.set('handle-1', 'old-key');
    await store.set('handle-1', 'new-key');
    expect(await store.get('handle-1')).toBe('new-key');
  });

  it('refuses to store a secret when OS-level encryption is unavailable', async () => {
    const { store } = setup(false);
    await expect(store.set('handle-1', 'sk-my-real-key')).rejects.toThrow(/encryption/i);
  });

  it('redacts a value it has set from a log line', async () => {
    const { store } = setup();
    await store.set('handle-1', 'sk-my-real-key');
    expect(store.redact('token was sk-my-real-key in the request', 'any')).toBe(
      'token was ***REDACTED*** in the request',
    );
  });

  it('redacts a value it has read (get) even without a set in this instance', async () => {
    const database = new LocalDatabase({ filePath: ':memory:' });
    const safeStorage = fakeSafeStorage();
    database.setSecretCiphertext('handle-1', Buffer.from('enc:sk-preexisting').toString('base64'));
    const store = createElectronSecretStore(database, safeStorage);
    await store.get('handle-1');
    expect(store.redact('leaked sk-preexisting here', 'any')).toBe('leaked ***REDACTED*** here');
  });

  it('keeps redacting a value after it has been deleted (a log line written before deletion)', async () => {
    const { store } = setup();
    await store.set('handle-1', 'sk-my-real-key');
    await store.delete('handle-1');
    expect(store.redact('token was sk-my-real-key', 'any')).toBe('token was ***REDACTED***');
  });

  it('does not redact an empty string', async () => {
    const { store } = setup();
    await store.set('handle-1', '');
    expect(store.redact('nothing to see here', 'any')).toBe('nothing to see here');
  });
});
