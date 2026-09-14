import { describe, expect, it } from 'vitest';
import {
  ArchiveEncryptionError,
  decryptArchive,
  encryptArchive,
  generateArchiveKey,
} from './encryption.js';

describe('generateArchiveKey', () => {
  it('generates a 32-byte (AES-256) key', () => {
    expect(generateArchiveKey().length).toBe(32);
  });

  it('generates a different key each call', () => {
    expect(generateArchiveKey().equals(generateArchiveKey())).toBe(false);
  });
});

describe('encryptArchive / decryptArchive round trip', () => {
  it('decrypts back to the exact original plaintext', () => {
    const key = generateArchiveKey();
    const plaintext = Buffer.from('the quick brown fox jumps over the lazy dog', 'utf8');
    const encrypted = encryptArchive(plaintext, key);
    expect(decryptArchive(encrypted, key)).toEqual(plaintext);
  });

  it('round-trips empty plaintext', () => {
    const key = generateArchiveKey();
    const encrypted = encryptArchive(Buffer.alloc(0), key);
    expect(decryptArchive(encrypted, key)).toEqual(Buffer.alloc(0));
  });

  it('round-trips large binary content', () => {
    const key = generateArchiveKey();
    const plaintext = Buffer.from(Array.from({ length: 100_000 }, (_, i) => i % 256));
    const encrypted = encryptArchive(plaintext, key);
    expect(decryptArchive(encrypted, key)).toEqual(plaintext);
  });

  it('produces a different ciphertext (and IV) for the same plaintext each time', () => {
    const key = generateArchiveKey();
    const plaintext = Buffer.from('hello', 'utf8');
    const a = encryptArchive(plaintext, key);
    const b = encryptArchive(plaintext, key);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  it('refuses to decrypt with the wrong key', () => {
    const encrypted = encryptArchive(Buffer.from('secret', 'utf8'), generateArchiveKey());
    expect(() => decryptArchive(encrypted, generateArchiveKey())).toThrow(ArchiveEncryptionError);
  });

  it('refuses to decrypt a tampered ciphertext (GCM auth tag catches it)', () => {
    const key = generateArchiveKey();
    const encrypted = encryptArchive(Buffer.from('secret', 'utf8'), key);
    const original = Buffer.from(encrypted.ciphertext, 'base64');
    const flipped = Buffer.from(original);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    const tampered = { ...encrypted, ciphertext: flipped.toString('base64') };
    expect(() => decryptArchive(tampered, key)).toThrow(ArchiveEncryptionError);
  });

  it('rejects a key of the wrong length for both encrypt and decrypt', () => {
    const shortKey = Buffer.alloc(16);
    expect(() => encryptArchive(Buffer.from('x'), shortKey)).toThrow(ArchiveEncryptionError);
    const encrypted = encryptArchive(Buffer.from('x'), generateArchiveKey());
    expect(() => decryptArchive(encrypted, shortKey)).toThrow(ArchiveEncryptionError);
  });
});
