import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkFileAgainstManifest,
  evaluateReleaseUpdate,
  parseReleaseManifest,
  parseSignatureText,
  ReleaseManifestError,
  verifyReleaseManifestSignature,
} from './index.js';

const SETUP_SHA = 'a'.repeat(64);

interface TestKey {
  readonly privateKey: KeyObject;
  readonly publicPem: string;
}

function testKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function signed(data: Uint8Array, key: TestKey): string {
  return sign(null, data, key.privateKey).toString('base64url');
}

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    channel: 'stable',
    version: '1.0.3',
    issuedAt: '2026-10-26T00:00:00Z',
    files: [{ name: 'joy-media-setup.exe', size: 202988544, sha256: SETUP_SHA }],
    ...overrides,
  });
}

describe('release signatures', () => {
  it('accepts a signature made over the exact bytes by a pinned key', () => {
    const key = testKey();
    const manifest = bytes(manifestJson());
    expect(
      verifyReleaseManifestSignature({
        manifest,
        signature: signed(manifest, key),
        publicKeysPem: [key.publicPem],
      }),
    ).toBe(true);
  });

  it('accepts a manifest signed by any one of several pinned keys, so a key can rotate', () => {
    const old = testKey();
    const next = testKey();
    const manifest = bytes(manifestJson());
    expect(
      verifyReleaseManifestSignature({
        manifest,
        signature: signed(manifest, next),
        publicKeysPem: [old.publicPem, next.publicPem],
      }),
    ).toBe(true);
  });

  it('refuses a manifest with one changed byte', () => {
    const key = testKey();
    const signature = signed(bytes(manifestJson()), key);
    expect(
      verifyReleaseManifestSignature({
        manifest: bytes(manifestJson({ version: '1.0.4' })),
        signature,
        publicKeysPem: [key.publicPem],
      }),
    ).toBe(false);
  });

  it('refuses a re-serialised manifest with the same fields, because the bytes differ', () => {
    const key = testKey();
    const signature = signed(bytes(manifestJson()), key);
    const reformatted = bytes(JSON.stringify(JSON.parse(manifestJson()), null, 2));
    expect(
      verifyReleaseManifestSignature({
        manifest: reformatted,
        signature,
        publicKeysPem: [key.publicPem],
      }),
    ).toBe(false);
  });

  it('refuses a signature from a key that is not pinned', () => {
    const pinned = testKey();
    const attacker = testKey();
    const manifest = bytes(manifestJson());
    expect(
      verifyReleaseManifestSignature({
        manifest,
        signature: signed(manifest, attacker),
        publicKeysPem: [pinned.publicPem],
      }),
    ).toBe(false);
  });

  it('refuses everything when no key is pinned', () => {
    const key = testKey();
    const manifest = bytes(manifestJson());
    expect(
      verifyReleaseManifestSignature({
        manifest,
        signature: signed(manifest, key),
        publicKeysPem: [],
      }),
    ).toBe(false);
  });

  it('refuses a pinned key that is not Ed25519', () => {
    const key = testKey();
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const manifest = bytes(manifestJson());
    expect(
      verifyReleaseManifestSignature({
        manifest,
        signature: signed(manifest, key),
        publicKeysPem: [ec.publicKey.export({ type: 'spki', format: 'pem' }).toString()],
      }),
    ).toBe(false);
  });

  it('refuses malformed signature text', () => {
    const key = testKey();
    const manifest = bytes(manifestJson());
    const good = signed(manifest, key);
    for (const bad of [`${good}=`, good.slice(1), `${good} `, 'not base64!', '']) {
      expect(
        verifyReleaseManifestSignature({
          manifest,
          signature: bad,
          publicKeysPem: [key.publicPem],
        }),
        bad,
      ).toBe(false);
    }
  });

  it('reads a signature file that ends in one line break and nothing else', () => {
    expect(parseSignatureText('abc\n')).toBe('abc');
    expect(parseSignatureText('abc\r\n')).toBe('abc');
    expect(parseSignatureText('abc \n')).toBe('abc ');
  });
});

describe('manifest schema', () => {
  it('parses a valid manifest, including the optional minimum version', () => {
    const manifest = parseReleaseManifest(bytes(manifestJson({ minSupportedVersion: '1.0.2' })));
    expect(manifest.version).toBe('1.0.3');
    expect(manifest.channel).toBe('stable');
    expect(manifest.minSupportedVersion).toBe('1.0.2');
    expect(manifest.files).toEqual([
      { name: 'joy-media-setup.exe', size: 202988544, sha256: SETUP_SHA },
    ]);
  });

  it.each([
    ['non-UTF-8 bytes', new Uint8Array([0xff, 0xfe, 0x00])],
    ['text that is not JSON', bytes('{')],
    ['a JSON array', bytes('[]')],
    ['an unknown top-level key', bytes(manifestJson({ downloadUrl: 'https://example.invalid/x' }))],
    ['an unknown channel', bytes(manifestJson({ channel: 'nightly' }))],
    ['a version that is not semver', bytes(manifestJson({ version: '1.0' }))],
    ['a version with a leading zero', bytes(manifestJson({ version: '01.0.3' }))],
    ['an issuedAt that is not UTC', bytes(manifestJson({ issuedAt: '2026-10-26 00:00' }))],
    [
      'a minimum version that is not semver',
      bytes(manifestJson({ minSupportedVersion: 'latest' })),
    ],
    ['an empty file list', bytes(manifestJson({ files: [] }))],
    [
      'a file name with a parent path',
      bytes(manifestJson({ files: [{ name: '../setup.exe', size: 1, sha256: SETUP_SHA }] })),
    ],
    [
      'a file name with a separator',
      bytes(manifestJson({ files: [{ name: 'dir/setup.exe', size: 1, sha256: SETUP_SHA }] })),
    ],
    [
      'two files with one name',
      bytes(
        manifestJson({
          files: [
            { name: 'a.exe', size: 1, sha256: SETUP_SHA },
            { name: 'a.exe', size: 2, sha256: SETUP_SHA },
          ],
        }),
      ),
    ],
    [
      'a zero size',
      bytes(manifestJson({ files: [{ name: 'a.exe', size: 0, sha256: SETUP_SHA }] })),
    ],
    [
      'a fractional size',
      bytes(manifestJson({ files: [{ name: 'a.exe', size: 1.5, sha256: SETUP_SHA }] })),
    ],
    [
      'an uppercase hash',
      bytes(manifestJson({ files: [{ name: 'a.exe', size: 1, sha256: 'A'.repeat(64) }] })),
    ],
    [
      'a file entry with an extra key',
      bytes(manifestJson({ files: [{ name: 'a.exe', size: 1, sha256: SETUP_SHA, url: 'x' }] })),
    ],
  ])('refuses %s', (_label, input) => {
    expect(() => parseReleaseManifest(input)).toThrow(ReleaseManifestError);
  });
});

describe('update decision', () => {
  const key = testKey();

  function decide(
    manifest: string,
    installedVersion: string,
    options: { readonly signedWith?: TestKey; readonly pinned?: readonly string[] } = {},
  ) {
    const data = bytes(manifest);
    return evaluateReleaseUpdate({
      manifestBytes: data,
      signature: signed(data, options.signedWith ?? key),
      installedVersion,
      publicKeysPem: options.pinned ?? [key.publicPem],
    });
  }

  it('blocks every update when no key is pinned, before any manifest is read', () => {
    const data = bytes(manifestJson());
    expect(
      evaluateReleaseUpdate({
        manifestBytes: data,
        signature: signed(data, key),
        installedVersion: '1.0.2',
        publicKeysPem: [],
      }),
    ).toEqual({ status: 'blocked', reason: 'release-key-unconfigured' });
  });

  it('blocks a manifest whose bytes changed after signing', () => {
    const data = bytes(manifestJson());
    const signature = signed(data, key);
    expect(
      evaluateReleaseUpdate({
        manifestBytes: bytes(manifestJson({ version: '9.9.9' })),
        signature,
        installedVersion: '1.0.2',
        publicKeysPem: [key.publicPem],
      }),
    ).toEqual({ status: 'blocked', reason: 'signature-invalid' });
  });

  it('blocks a validly signed manifest whose schema is invalid', () => {
    expect(decide(manifestJson({ files: [] }), '1.0.2')).toEqual({
      status: 'blocked',
      reason: 'manifest-invalid',
    });
  });

  it('blocks a validly signed beta manifest on the stable channel', () => {
    expect(decide(manifestJson({ channel: 'beta' }), '1.0.2')).toEqual({
      status: 'blocked',
      reason: 'channel-mismatch',
    });
  });

  it('blocks a manifest signed by a key that is not pinned', () => {
    const attacker = testKey();
    expect(decide(manifestJson(), '1.0.2', { signedWith: attacker })).toEqual({
      status: 'blocked',
      reason: 'signature-invalid',
    });
  });

  it('reports the same version as current, not as an update', () => {
    expect(decide(manifestJson(), '1.0.3')).toEqual({
      status: 'current',
      reason: 'not-newer',
      latestVersion: '1.0.3',
    });
  });

  it('refuses a downgrade: an older but validly signed manifest is not newer', () => {
    expect(decide(manifestJson({ version: '1.0.2' }), '1.0.4')).toEqual({
      status: 'current',
      reason: 'not-newer',
      latestVersion: '1.0.2',
    });
  });

  it('offers a newer validly signed version as an update', () => {
    const decision = decide(manifestJson(), '1.0.2');
    expect(decision.status).toBe('update');
    if (decision.status !== 'update') return;
    expect(decision.manifest.version).toBe('1.0.3');
    expect(decision.forced).toBe(false);
  });

  it('marks an update forced when the installed version is below the minimum supported version', () => {
    const decision = decide(manifestJson({ minSupportedVersion: '1.0.2' }), '1.0.1');
    expect(decision.status === 'update' && decision.forced).toBe(true);
  });

  it('ranks a prerelease below its release', () => {
    expect(decide(manifestJson({ version: '1.0.3-rc.1' }), '1.0.3')).toMatchObject({
      status: 'current',
      reason: 'not-newer',
    });
    expect(decide(manifestJson({ version: '1.0.3' }), '1.0.3-rc.1')).toMatchObject({
      status: 'update',
    });
  });

  it('blocks when the installed version is not a plain semantic version', () => {
    expect(decide(manifestJson(), 'v1.0.2')).toEqual({
      status: 'blocked',
      reason: 'installed-version-invalid',
    });
  });
});

describe('file checks against the signed manifest', () => {
  const manifest = parseReleaseManifest(bytes(manifestJson()));

  it('accepts a listed file whose size and digest match', () => {
    expect(
      checkFileAgainstManifest(manifest, 'joy-media-setup.exe', {
        size: 202988544,
        sha256: SETUP_SHA,
      }).ok,
    ).toBe(true);
  });

  it('refuses a file the manifest does not list', () => {
    expect(
      checkFileAgainstManifest(manifest, 'other.exe', { size: 202988544, sha256: SETUP_SHA }),
    ).toEqual({ ok: false, reason: 'not-listed' });
  });

  it('refuses a file whose size differs', () => {
    expect(
      checkFileAgainstManifest(manifest, 'joy-media-setup.exe', { size: 1, sha256: SETUP_SHA }),
    ).toEqual({ ok: false, reason: 'size-mismatch' });
  });

  it('refuses a file whose digest differs', () => {
    expect(
      checkFileAgainstManifest(manifest, 'joy-media-setup.exe', {
        size: 202988544,
        sha256: 'b'.repeat(64),
      }),
    ).toEqual({ ok: false, reason: 'digest-mismatch' });
  });
});
