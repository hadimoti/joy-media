import type { SecretStore } from '@joy-media/provider-sdk';
import type { LocalDatabase } from '../../store/local-database.js';

/**
 * The subset of Electron's `safeStorage` this module depends on. `safeStorage` wraps the OS's
 * own credential protection — DPAPI on Windows, Keychain on macOS, libsecret on Linux — which
 * is exactly the "Windows-protected storage (DPAPI/Keychain equivalent)" the locked owner
 * decision requires for provider API keys. Kept as an injected interface (not a direct
 * `import { safeStorage } from 'electron'`) so this module is unit-testable without a real
 * Electron runtime, same pattern as every other `apps/desktop/src/main/*` module.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * Implements `@joy-media/provider-sdk`'s `SecretStore` contract (the same interface
 * `createMemorySecretStore` implements) over Electron's OS-level encryption plus
 * `LocalDatabase`'s `secrets` table for ciphertext persistence.
 *
 * Mirrors the reference in-memory implementation's `redact()` behavior: every value this
 * store has encrypted or decrypted during the process lifetime stays redactable, even after
 * `delete()` — a log line written before a key was deleted must still be redactable after.
 * This is deliberately a volatile, in-memory redaction set, never persisted: it exists only so
 * `redact()` can work synchronously (the `SecretStore` contract does not allow an async
 * redact), and it never contains anything that was not already decrypted for a real use.
 */
export function createElectronSecretStore(
  database: LocalDatabase,
  safeStorage: SafeStorageLike,
): SecretStore {
  const knownPlaintextValues = new Set<string>();

  return {
    async set(handleId, value) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(
          'OS-level secret encryption is unavailable on this machine; refusing to store the ' +
            'provider key in plaintext',
        );
      }
      const ciphertext = safeStorage.encryptString(value);
      database.setSecretCiphertext(handleId, ciphertext.toString('base64'));
      if (value.length > 0) knownPlaintextValues.add(value);
    },

    async get(handleId) {
      const ciphertextBase64 = database.getSecretCiphertext(handleId);
      if (ciphertextBase64 === undefined) return null;
      const value = safeStorage.decryptString(Buffer.from(ciphertextBase64, 'base64'));
      if (value.length > 0) knownPlaintextValues.add(value);
      return value;
    },

    async delete(handleId) {
      database.deleteSecretCiphertext(handleId);
    },

    redact(logLine, _providerId) {
      let result = logLine;
      for (const value of knownPlaintextValues) {
        result = result.replaceAll(value, '***REDACTED***');
      }
      return result;
    },
  };
}
