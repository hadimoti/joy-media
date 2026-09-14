import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM archive encryption (JOY Media desktop migration, wave 6). Locked owner
 * decision: "Provide a reversible, encrypted, checksummed archive export."
 *
 * The key is generated fresh per export and returned to the caller — it is never derived
 * from anything server-controlled and never persisted by this module. A caller (a future
 * export route) hands the key to the owner exactly once (e.g., a one-time download/display),
 * the same pattern a password-manager or backup-codes flow uses: whoever holds the key can
 * decrypt, and nothing here can decrypt without it.
 */

export class ArchiveEncryptionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveEncryptionError';
  }
}

export interface EncryptedPayload {
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
}

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM-recommended nonce length

export function generateArchiveKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function encryptArchive(plaintext: Uint8Array, key: Buffer): EncryptedPayload {
  if (key.length !== KEY_BYTES) {
    throw new ArchiveEncryptionError('KEY_LENGTH_INVALID', `key must be ${KEY_BYTES} bytes`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

/** Throws `ArchiveEncryptionError` for a wrong key or a tampered payload — GCM's built-in
 * authentication tag makes those indistinguishable from each other by design, and both must
 * fail closed the same way. */
export function decryptArchive(payload: EncryptedPayload, key: Buffer): Buffer {
  if (key.length !== KEY_BYTES) {
    throw new ArchiveEncryptionError('KEY_LENGTH_INVALID', `key must be ${KEY_BYTES} bytes`);
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final(),
    ]);
  } catch (error) {
    throw new ArchiveEncryptionError(
      'DECRYPTION_FAILED',
      `archive could not be decrypted: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}
