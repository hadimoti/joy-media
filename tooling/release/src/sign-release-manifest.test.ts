import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signManifestBytes, verifyManifestBytes } from './sign-release-manifest.mjs';

// Development keys only. The owner's release key is never generated, stored or read by the tests.
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'sign-release-manifest.mjs');
const MANIFEST = Buffer.from('{"channel":"stable","version":"1.0.3"}\n', 'utf8');

function devKeyPair(): { privatePem: string; publicPem: string } {
  const pair = generateKeyPairSync('ed25519');
  return {
    privatePem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sign-release-manifest-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('release manifest signing', () => {
  it('signs exact manifest bytes and verifies them, and refuses any other bytes', () => {
    const keys = devKeyPair();
    const signature = signManifestBytes(MANIFEST, keys.privatePem);
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
    expect(verifyManifestBytes(MANIFEST, signature, keys.publicPem)).toBe(true);
    expect(
      verifyManifestBytes(Buffer.from('{"channel":"beta"}\n'), signature, keys.publicPem),
    ).toBe(false);
  });

  it('refuses a signature under a different key', () => {
    const signer = devKeyPair();
    const other = devKeyPair();
    const signature = signManifestBytes(MANIFEST, signer.privatePem);
    expect(verifyManifestBytes(MANIFEST, signature, other.publicPem)).toBe(false);
  });

  it('refuses to sign with a key that is not Ed25519', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => signManifestBytes(MANIFEST, privatePem)).toThrow(/Ed25519/u);
  });

  it('round-trips through the command line with key and manifest files on disk', () => {
    const keys = devKeyPair();
    const manifestPath = join(directory, 'release-manifest.json');
    const keyPath = join(directory, 'dev-release-key.pem');
    const sigPath = join(directory, 'release-manifest.json.sig');
    const publicPath = join(directory, 'dev-release-key.pub.pem');
    writeFileSync(manifestPath, MANIFEST);
    writeFileSync(keyPath, keys.privatePem);
    writeFileSync(publicPath, keys.publicPem);

    execFileSync(process.execPath, [
      script,
      'sign',
      '--manifest',
      manifestPath,
      '--key',
      keyPath,
      '--out',
      sigPath,
    ]);
    const verified = execFileSync(process.execPath, [
      script,
      'verify',
      '--manifest',
      manifestPath,
      '--sig',
      sigPath,
      '--pub',
      publicPath,
    ]).toString('utf8');
    expect(verified).toContain('signature verified');
    expect(readFileSync(sigPath, 'utf8').trim()).toBe(signManifestBytes(MANIFEST, keys.privatePem));

    writeFileSync(manifestPath, Buffer.concat([MANIFEST, Buffer.from(' ')]));
    expect(() =>
      execFileSync(process.execPath, [
        script,
        'verify',
        '--manifest',
        manifestPath,
        '--sig',
        sigPath,
        '--pub',
        publicPath,
      ]),
    ).toThrow();
  });
});
