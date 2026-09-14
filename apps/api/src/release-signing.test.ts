import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createEd25519ReleaseSigner,
  DisabledReleaseSigner,
  readReleaseSigningKeyFromCredential,
  verifyReleaseManifest,
  type ReleaseManifestPayload,
} from './release-signing.js';

function signer() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return createEd25519ReleaseSigner(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
}

const payload: ReleaseManifestPayload = {
  channel: 'stable',
  version: '1.2.3',
  downloadUrl: 'https://joyst.ir/downloads/joy-media-1.2.3.exe',
  sha256: 'a'.repeat(64),
  minSupportedVersion: '1.0.0',
};

describe('release signing', () => {
  it('signs and verifies a release manifest with Ed25519', () => {
    const releaseSigner = signer();
    const signed = releaseSigner.sign(payload);
    expect(verifyReleaseManifest(signed, releaseSigner.publicKeyPem)).toBe(true);
  });

  it('rejects payload or signature tampering', () => {
    const releaseSigner = signer();
    const signed = releaseSigner.sign(payload);
    expect(
      verifyReleaseManifest(
        { ...signed, payload: { ...payload, version: '9.9.9' } },
        releaseSigner.publicKeyPem,
      ),
    ).toBe(false);
    expect(
      verifyReleaseManifest(
        { ...signed, signature: 'A'.repeat(signed.signature.length) },
        releaseSigner.publicKeyPem,
      ),
    ).toBe(false);
  });

  it('rejects non-Ed25519 signing keys and disabled signing', () => {
    const { privateKey: rsaKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() =>
      createEd25519ReleaseSigner(rsaKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    ).toThrowError(expect.objectContaining({ code: 'SIGNING_KEY_INVALID' }));
    expect(() => new DisabledReleaseSigner().sign(payload)).toThrowError(
      expect.objectContaining({ code: 'SIGNING_UNCONFIGURED' }),
    );
  });

  it('reads a non-empty systemd credential and fails closed for missing/empty files', () => {
    const seen: string[] = [];
    expect(
      readReleaseSigningKeyFromCredential((path) => {
        seen.push(path);
        return ' key-material\n';
      }, '/credential-dir'),
    ).toBe(' key-material\n');
    expect(readReleaseSigningKeyFromCredential(() => '', '/credential-dir')).toBeUndefined();
    expect(
      readReleaseSigningKeyFromCredential(() => {
        throw new Error('missing');
      }, '/credential-dir'),
    ).toBeUndefined();
    expect(seen).toEqual(['/credential-dir/joy-media-release-signing-key']);
  });
});
