import { describe, expect, it } from 'vitest';
import { exportOwnerArchive } from './archive-export.js';
import type { ProjectArchiveSource } from './archive-export.js';
import { ArchiveImportError, importOwnerArchive } from './archive-import.js';
import {
  ArchiveEncryptionError,
  decryptArchive,
  encryptArchive,
  generateArchiveKey,
} from './encryption.js';
import type { ArchiveBundle } from './archive-export.js';

function sourceWithOneProject(): ProjectArchiveSource {
  return {
    async listProjects() {
      return [{ id: 'proj-1', document: { title: 'A' } }];
    },
    async listMediaAssets() {
      return [{ id: 'asset-1', displayName: 'clip.mp4', bytes: Buffer.from('abc') }];
    },
  };
}

describe('importOwnerArchive', () => {
  it('round-trips a real export back to its exact entries', async () => {
    const exported = await exportOwnerArchive(
      'user@example.com',
      sourceWithOneProject(),
      () => 'T0',
    );
    const imported = importOwnerArchive(exported.encrypted, exported.keyBase64);
    expect(imported.manifest).toEqual(exported.manifest);
    expect(imported.entries.map((e) => e.name).sort()).toEqual([
      'media/proj-1/asset-1-clip.mp4',
      'projects/proj-1.json',
    ]);
  });

  it('refuses to import with the wrong key', async () => {
    const exported = await exportOwnerArchive(
      'user@example.com',
      sourceWithOneProject(),
      () => 'T0',
    );
    expect(() =>
      importOwnerArchive(exported.encrypted, generateArchiveKey().toString('base64')),
    ).toThrow(ArchiveEncryptionError);
  });

  it('refuses to import a tampered ciphertext', async () => {
    const exported = await exportOwnerArchive(
      'user@example.com',
      sourceWithOneProject(),
      () => 'T0',
    );
    const bytes = Buffer.from(exported.encrypted.ciphertext, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered = { ...exported.encrypted, ciphertext: bytes.toString('base64') };
    expect(() => importOwnerArchive(tampered, exported.keyBase64)).toThrow(ArchiveEncryptionError);
  });

  it('refuses a payload that decrypts to non-JSON', () => {
    const key = generateArchiveKey();
    const encrypted = encryptArchive(Buffer.from('not json at all'), key);
    expect(() => importOwnerArchive(encrypted, key.toString('base64'))).toThrow(ArchiveImportError);
  });

  it('refuses a payload missing the expected {manifest, entries} shape', () => {
    const key = generateArchiveKey();
    const encrypted = encryptArchive(Buffer.from(JSON.stringify({ hello: 'world' })), key);
    expect(() => importOwnerArchive(encrypted, key.toString('base64'))).toThrow(ArchiveImportError);
  });

  it('refuses an archive whose manifest checksum does not match its (tampered) entries', async () => {
    const exported = await exportOwnerArchive(
      'user@example.com',
      sourceWithOneProject(),
      () => 'T0',
    );
    const key = Buffer.from(exported.keyBase64, 'base64');

    // Decrypt, tamper with an entry's plaintext bytes, re-encrypt with the same key: GCM
    // authentication accepts it (it's a legitimately fresh encryption of different bytes),
    // so this exercises the *manifest checksum* check specifically, independent of the
    // ciphertext-authenticity check already covered above.
    const plaintext = decryptArchive(exported.encrypted, key);
    const bundle = JSON.parse(plaintext.toString('utf8')) as ArchiveBundle;
    const tamperedBundle: ArchiveBundle = {
      ...bundle,
      entries: bundle.entries.map((entry) =>
        entry.name === 'projects/proj-1.json'
          ? { ...entry, bytesBase64: Buffer.from('{"title":"TAMPERED"}').toString('base64') }
          : entry,
      ),
    };
    const reEncrypted = encryptArchive(Buffer.from(JSON.stringify(tamperedBundle)), key);

    expect(() => importOwnerArchive(reEncrypted, exported.keyBase64)).toThrow(ArchiveImportError);
  });
});
