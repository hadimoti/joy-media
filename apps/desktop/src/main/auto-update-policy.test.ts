import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evaluateAutoUpdate } from './auto-update-policy.js';

function release() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const payload = {
    channel: 'stable',
    version: '1.2.0',
    downloadUrl: 'https://joyst.ir/downloads/joy-media-1.2.0.exe',
    sha256: 'a'.repeat(64),
    minSupportedVersion: '1.0.0',
  } as const;
  const manifest = {
    payload,
    signature: sign(null, Buffer.from(JSON.stringify(payload), 'utf8'), privateKey).toString(
      'base64url',
    ),
  };
  // The policy's canonical payload has the same stable field order as this fixture.
  return { manifest, publicKeyPem };
}

describe('evaluateAutoUpdate', () => {
  it('accepts a newer verified release but leaves downloading opt-in', () => {
    const { manifest, publicKeyPem } = release();
    expect(
      evaluateAutoUpdate({
        manifest,
        currentVersion: '1.1.0',
        subscriptionActive: true,
        pinnedPublicKeyPem: publicKeyPem,
      }),
    ).toMatchObject({ status: 'update', forced: false, autoDownload: false });
  });

  it('requires an active subscription and a pinned key', () => {
    const { manifest, publicKeyPem } = release();
    expect(
      evaluateAutoUpdate({
        manifest,
        currentVersion: '1.1.0',
        subscriptionActive: false,
        pinnedPublicKeyPem: publicKeyPem,
      }),
    ).toEqual({ status: 'blocked', reason: 'subscription-required' });
    expect(
      evaluateAutoUpdate({ manifest, currentVersion: '1.1.0', subscriptionActive: true }),
    ).toEqual({ status: 'blocked', reason: 'release-key-unconfigured' });
  });

  it('rejects a bad signature, unsafe URL, malformed hash, and downgrade', () => {
    const { manifest, publicKeyPem } = release();
    expect(
      evaluateAutoUpdate({
        manifest: {
          ...manifest,
          signature: `${manifest.signature[0] === 'A' ? 'B' : 'A'}${manifest.signature.slice(1)}`,
        },
        currentVersion: '1.1.0',
        subscriptionActive: true,
        pinnedPublicKeyPem: publicKeyPem,
      }),
    ).toEqual({ status: 'blocked', reason: 'signature-invalid' });
    const unsafe = {
      ...manifest,
      payload: { ...manifest.payload, downloadUrl: 'http://joyst.ir/file.exe' },
    };
    expect(
      evaluateAutoUpdate({
        manifest: unsafe,
        currentVersion: '1.1.0',
        subscriptionActive: true,
        pinnedPublicKeyPem: publicKeyPem,
      }),
    ).toEqual({ status: 'blocked', reason: 'manifest-invalid' });
    const malformedHash = { ...manifest, payload: { ...manifest.payload, sha256: 'bad' } };
    expect(
      evaluateAutoUpdate({
        manifest: malformedHash,
        currentVersion: '1.1.0',
        subscriptionActive: true,
        pinnedPublicKeyPem: publicKeyPem,
      }),
    ).toEqual({ status: 'blocked', reason: 'manifest-invalid' });
    expect(
      evaluateAutoUpdate({
        manifest,
        currentVersion: '2.0.0',
        subscriptionActive: true,
        pinnedPublicKeyPem: publicKeyPem,
      }),
    ).toEqual({ status: 'current', reason: 'not-newer' });
  });

  it('marks a release forced when the current version is below its minimum', () => {
    const { manifest, publicKeyPem } = release();
    expect(
      evaluateAutoUpdate({
        manifest,
        currentVersion: '0.9.0',
        subscriptionActive: true,
        pinnedPublicKeyPem: publicKeyPem,
        allowAutomaticDownload: true,
      }),
    ).toMatchObject({ status: 'update', forced: true, autoDownload: true });
  });
});
