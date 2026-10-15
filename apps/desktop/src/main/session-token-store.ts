import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SafeStorageLike } from './secrets/electron-secret-store.js';

export interface SessionTokenStore {
  get(): Promise<string | undefined>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
  /** False when the token is kept in memory only (no OS keyring) and will not survive a restart. */
  isPersistent?(): boolean;
}

/** Stores the session token encrypted by Electron safeStorage in the app's userData folder. */
export function createSessionTokenStore(
  filePath: string,
  safeStorage: SafeStorageLike,
  onWarning: (message: string) => void = console.warn,
): SessionTokenStore {
  let memoryToken: string | undefined;
  let warnedUnavailable = false;

  const encryptionAvailable = (): boolean => {
    // Electron can report safeStorage as available while selecting Linux's `basic_text`
    // backend, which only obfuscates data. Treat that backend as unavailable for tokens.
    const available =
      safeStorage.isEncryptionAvailable() &&
      safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
    if (!available && !warnedUnavailable) {
      warnedUnavailable = true;
      onWarning(
        'OS-level session token encryption is unavailable; the token will be kept in memory only for this session.',
      );
    }
    return available;
  };

  return {
    isPersistent: () => encryptionAvailable(),
    async get() {
      if (!encryptionAvailable()) return memoryToken;
      try {
        const ciphertext = fs.readFileSync(filePath);
        const token = safeStorage.decryptString(ciphertext);
        if (token.length === 0 || token.length > 8192)
          throw new Error('session token file is not a token');
        memoryToken = token;
        return token;
      } catch (error) {
        // A single decrypt failure keeps the file: a transient keyring glitch must not sign the
        // user out permanently (r17 follow-up). Only a value that decodes but is not a token is
        // removed.
        if (error instanceof Error && error.message === 'session token file is not a token') {
          memoryToken = undefined;
          try {
            fs.rmSync(filePath, { force: true });
          } catch {
            // Treated as absent even if the file cannot be removed.
          }
        }
        return undefined;
      }
    },

    async set(token) {
      memoryToken = token;
      if (!encryptionAvailable()) return;
      const ciphertext = safeStorage.encryptString(token);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporaryPath, ciphertext, { mode: 0o600, flag: 'wx' });
        if (process.platform !== 'win32') fs.chmodSync(temporaryPath, 0o600);
        fs.renameSync(temporaryPath, filePath);
        if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
      } finally {
        fs.rmSync(temporaryPath, { force: true });
      }
    },

    async clear() {
      memoryToken = undefined;
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // Clearing the in-memory token remains effective if the disk is unavailable.
      }
    },
  };
}
