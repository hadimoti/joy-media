// Development keys only. Every key in this file is generated for the test run, is labelled as development, and is never
// pinned in a build. The owner's release key is not generated, read or stored here (decision D2).
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compareVersions, evaluateReleaseUpdate } from './policy.js';

interface DevelopmentKey {
  readonly privateKey: KeyObject;
  readonly publicPem: string;
}

function developmentEd25519Key(): DevelopmentKey {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    publicPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function manifest(overrides: Record<string, unknown> = {}): Uint8Array {
  const document = {
    channel: 'stable',
    version: '1.0.4',
    issuedAt: '2026-10-26T00:00:00Z',
    files: [{ name: 'joy-media-setup.exe', size: 1024, sha256: 'a'.repeat(64) }],
    ...overrides,
  };
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

/** Signs exact bytes the way the owner's tool does: detached Ed25519, unpadded base64url, one line break. */
function signed(bytes: Uint8Array, key: DevelopmentKey): string {
  return `${sign(null, bytes, key.privateKey).toString('base64url')}\n`;
}

const INSTALLED = '1.0.3';
const dev = developmentEd25519Key();
const other = developmentEd25519Key();

function decide(
  bytes: Uint8Array,
  signature: string,
  options: Partial<Parameters<typeof evaluateReleaseUpdate>[0]> = {},
) {
  return evaluateReleaseUpdate({
    manifestBytes: bytes,
    signature,
    installedVersion: INSTALLED,
    publicKeysPem: [dev.publicPem],
    ...options,
  });
}

describe('accepting a release (positive)', () => {
  it('offers a newer stable release that a pinned key signed', () => {
    const bytes = manifest();
    const decision = decide(bytes, signed(bytes, dev));

    expect(decision).toMatchObject({
      status: 'update',
      forced: false,
      manifest: { version: '1.0.4', channel: 'stable' },
    });
  });

  it('accepts a manifest signed by any pinned key, so a key can rotate', () => {
    const bytes = manifest({ version: '1.0.5' });
    const decision = decide(bytes, signed(bytes, other), {
      publicKeysPem: [dev.publicPem, other.publicPem],
    });

    expect(decision.status).toBe('update');
  });

  it('marks a release as required when the installed version is below its minimum supported version', () => {
    const bytes = manifest({ minSupportedVersion: '1.0.4' });
    const decision = decide(bytes, signed(bytes, dev));

    expect(decision).toMatchObject({ status: 'update', forced: true });
  });

  it('offers a beta release to an install that follows the beta channel', () => {
    const bytes = manifest({ channel: 'beta', version: '1.0.4-beta.1' });
    const decision = decide(bytes, signed(bytes, dev), { installedChannel: 'beta' });

    expect(decision.status).toBe('update');
  });
});

describe('refusing a release (negative)', () => {
  it('blocks every check while no key is pinned, even for a correctly signed manifest', () => {
    const bytes = manifest();
    expect(decide(bytes, signed(bytes, dev), { publicKeysPem: [] })).toEqual({
      status: 'blocked',
      reason: 'release-key-unconfigured',
    });
  });

  it('blocks an installed version that is not a version', () => {
    const bytes = manifest();
    expect(decide(bytes, signed(bytes, dev), { installedVersion: 'latest' })).toEqual({
      status: 'blocked',
      reason: 'installed-version-invalid',
    });
  });

  it('refuses a manifest signed by a key that is not pinned', () => {
    const bytes = manifest();
    expect(decide(bytes, signed(bytes, other))).toEqual({
      status: 'blocked',
      reason: 'signature-invalid',
    });
  });

  it('refuses a manifest whose bytes changed after signing, even when only the version digit changed', () => {
    const original = manifest({ version: '1.0.4' });
    const signature = signed(original, dev);
    const tampered = manifest({ version: '1.0.5' });

    expect(decide(tampered, signature)).toEqual({ status: 'blocked', reason: 'signature-invalid' });
  });

  it('refuses a signature that is not unpadded base64url of 64 bytes', () => {
    const bytes = manifest();
    const good = signed(bytes, dev).replace(/\r?\n$/u, '');
    const padded = `${good}==`;
    const truncated = good.slice(0, -4);
    const notBase64 = `${good.slice(0, -1)}+`;

    for (const signature of [padded, truncated, notBase64, '']) {
      expect(decide(bytes, signature), signature).toEqual({
        status: 'blocked',
        reason: 'signature-invalid',
      });
    }
  });

  it('refuses a pinned key that is not Ed25519, without throwing', () => {
    const bytes = manifest();
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ecPem = ec.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const signature = `${sign('sha256', bytes, ec.privateKey).toString('base64url')}\n`;

    expect(decide(bytes, signature, { publicKeysPem: [ecPem] })).toEqual({
      status: 'blocked',
      reason: 'signature-invalid',
    });
  });

  it('refuses a pinned entry that is not a key at all, without throwing', () => {
    const bytes = manifest();
    expect(decide(bytes, signed(bytes, dev), { publicKeysPem: ['not a key'] })).toEqual({
      status: 'blocked',
      reason: 'signature-invalid',
    });
  });

  it('refuses a validly signed document that is not a manifest', () => {
    const notJson = Buffer.from('this is not json', 'utf8');
    const notObject = Buffer.from('[]', 'utf8');
    const badChannel = manifest({ channel: 'nightly' });

    for (const bytes of [notJson, notObject, badChannel]) {
      expect(decide(bytes, signed(bytes, dev))).toEqual({
        status: 'blocked',
        reason: 'manifest-invalid',
      });
    }
  });

  it('refuses a beta release on a stable install', () => {
    const bytes = manifest({ channel: 'beta', version: '1.0.4-beta.1' });
    expect(decide(bytes, signed(bytes, dev), { installedChannel: 'stable' })).toEqual({
      status: 'blocked',
      reason: 'channel-mismatch',
    });
  });

  it('never offers a downgrade: an older release validly signed by the owner is only "not newer"', () => {
    const bytes = manifest({ version: '1.0.2' });
    expect(decide(bytes, signed(bytes, dev))).toEqual({
      status: 'current',
      reason: 'not-newer',
      latestVersion: '1.0.2',
    });
  });

  it('reports the same version as current, not as an update', () => {
    const bytes = manifest({ version: INSTALLED });
    expect(decide(bytes, signed(bytes, dev)).status).toBe('current');
  });
});

describe('version ordering', () => {
  it('orders numbers as numbers, and a release above its prereleases', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.3', '1.0.3-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.3', '1.0.3')).toBe(0);
    expect(compareVersions('1.0.2', '1.0.3')).toBeLessThan(0);
  });
});
