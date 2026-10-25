import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyReleaseManifestSignature } from './release-manifest-signature.js';

// Development keys only: generated per test run, never the owner's release key.
interface DevKey {
  readonly privateKey: KeyObject;
  readonly publicPem: string;
}

function devKey(): DevKey {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    publicPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

const MANIFEST = Buffer.from(
  '{"channel":"stable","version":"1.0.3","sha256":"' + 'a'.repeat(64) + '"}\n',
  'utf8',
);

function signWith(key: DevKey, bytes: Uint8Array): string {
  return sign(null, bytes, key.privateKey).toString('base64url');
}

describe('verifyReleaseManifestSignature', () => {
  it('accepts the exact manifest bytes that a pinned key signed', () => {
    const key = devKey();
    expect(
      verifyReleaseManifestSignature({
        manifest: MANIFEST,
        signature: signWith(key, MANIFEST),
        publicKeysPem: [key.publicPem],
      }),
    ).toBe(true);
  });

  it('refuses a manifest whose bytes differ at all, even when its JSON value is the same', () => {
    const key = devKey();
    const signature = signWith(key, MANIFEST);
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(MANIFEST.toString('utf8'))), 'utf8');
    expect(reformatted.equals(MANIFEST)).toBe(false);
    expect(
      verifyReleaseManifestSignature({
        manifest: reformatted,
        signature,
        publicKeysPem: [key.publicPem],
      }),
      'a re-serialised manifest is not the signed file',
    ).toBe(false);
  });

  it('refuses a manifest with one changed byte', () => {
    const key = devKey();
    const tampered = Buffer.from(MANIFEST);
    tampered[tampered.length - 2] = 0x30;
    expect(
      verifyReleaseManifestSignature({
        manifest: tampered,
        signature: signWith(key, MANIFEST),
        publicKeysPem: [key.publicPem],
      }),
    ).toBe(false);
  });

  it('refuses a signature made by a key that is not pinned', () => {
    const pinned = devKey();
    const other = devKey();
    expect(
      verifyReleaseManifestSignature({
        manifest: MANIFEST,
        signature: signWith(other, MANIFEST),
        publicKeysPem: [pinned.publicPem],
      }),
    ).toBe(false);
  });

  it('accepts a manifest signed by either of two pinned keys, so a key can rotate', () => {
    const current = devKey();
    const next = devKey();
    const pins = [current.publicPem, next.publicPem];
    expect(
      verifyReleaseManifestSignature({
        manifest: MANIFEST,
        signature: signWith(current, MANIFEST),
        publicKeysPem: pins,
      }),
    ).toBe(true);
    expect(
      verifyReleaseManifestSignature({
        manifest: MANIFEST,
        signature: signWith(next, MANIFEST),
        publicKeysPem: pins,
      }),
    ).toBe(true);
  });

  it('refuses everything when no key is pinned', () => {
    const key = devKey();
    expect(
      verifyReleaseManifestSignature({
        manifest: MANIFEST,
        signature: signWith(key, MANIFEST),
        publicKeysPem: [],
      }),
      'an unconfigured release key must fail closed',
    ).toBe(false);
  });

  it('refuses a malformed signature, and a pinned key that is not Ed25519', () => {
    const key = devKey();
    const signature = signWith(key, MANIFEST);
    expect(
      verifyReleaseManifestSignature({
        manifest: MANIFEST,
        signature: signature.slice(0, -2),
        publicKeysPem: [key.publicPem],
      }),
      'a truncated signature',
    ).toBe(false);
    expect(
      verifyReleaseManifestSignature({
        manifest: MANIFEST,
        signature: `${signature}=`,
        publicKeysPem: [key.publicPem],
      }),
      'a padded signature is not the canonical base64url form',
    ).toBe(false);

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(
      verifyReleaseManifestSignature({
        manifest: MANIFEST,
        signature,
        publicKeysPem: [rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString()],
      }),
      'only Ed25519 release keys are accepted',
    ).toBe(false);
  });
});
