import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createEd25519EntitlementSigner,
  DisabledEntitlementSigner,
  ENTITLEMENT_SIGNING_KEY_SYSTEMD_CREDENTIAL_ID,
  EntitlementSigningError,
  readEntitlementSigningKeyFromCredential,
  verifyEntitlement,
} from './entitlement-signing.js';
import type { EntitlementPayload } from './entitlement-signing.js';

function pemKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function samplePayload(overrides: Partial<EntitlementPayload> = {}): EntitlementPayload {
  return {
    deviceId: 'device-1',
    ownerId: 'user@example.com',
    plan: 'monthly',
    subscriptionStatus: 'active',
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + 86_400_000,
    ...overrides,
  };
}

describe('createEd25519EntitlementSigner', () => {
  it('signs a payload that verifies against the matching public key', () => {
    const { privateKeyPem, publicKeyPem } = pemKeyPair();
    const signer = createEd25519EntitlementSigner(privateKeyPem);
    const signed = signer.sign(samplePayload());
    expect(verifyEntitlement(signed, publicKeyPem)).toBe(true);
    expect(verifyEntitlement(signed, signer.publicKeyPem)).toBe(true);
  });

  it('exposes the public key derived from the private key, in SPKI PEM form', () => {
    const { privateKeyPem, publicKeyPem } = pemKeyPair();
    const signer = createEd25519EntitlementSigner(privateKeyPem);
    expect(signer.publicKeyPem.trim()).toBe(publicKeyPem.trim());
  });

  it('rejects a non-Ed25519 key rather than silently signing with the wrong algorithm', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => createEd25519EntitlementSigner(rsaPem)).toThrow(EntitlementSigningError);
  });

  it('rejects an unparsable key', () => {
    expect(() => createEd25519EntitlementSigner('not a pem key')).toThrow(EntitlementSigningError);
  });
});

describe('verifyEntitlement', () => {
  it('fails verification against a different key pair', () => {
    const a = pemKeyPair();
    const b = pemKeyPair();
    const signed = createEd25519EntitlementSigner(a.privateKeyPem).sign(samplePayload());
    expect(verifyEntitlement(signed, b.publicKeyPem)).toBe(false);
  });

  it('fails verification if the payload was tampered with after signing', () => {
    const { privateKeyPem, publicKeyPem } = pemKeyPair();
    const signed = createEd25519EntitlementSigner(privateKeyPem).sign(samplePayload());
    const tampered = { ...signed, payload: { ...signed.payload, plan: 'yearly' as const } };
    expect(verifyEntitlement(tampered, publicKeyPem)).toBe(false);
  });

  it('fails verification for a garbage signature rather than throwing', () => {
    const { publicKeyPem } = pemKeyPair();
    expect(
      verifyEntitlement({ payload: samplePayload(), signature: 'not-base64url-sig' }, publicKeyPem),
    ).toBe(false);
  });

  it('fails verification against a garbage public key rather than throwing', () => {
    const { privateKeyPem } = pemKeyPair();
    const signed = createEd25519EntitlementSigner(privateKeyPem).sign(samplePayload());
    expect(verifyEntitlement(signed, 'not a pem key')).toBe(false);
  });
});

describe('readEntitlementSigningKeyFromCredential', () => {
  it('reads the key from the expected systemd credential path', () => {
    const { privateKeyPem } = pemKeyPair();
    const reads: string[] = [];
    const value = readEntitlementSigningKeyFromCredential((path) => {
      reads.push(path);
      return privateKeyPem;
    }, '/run/credentials/joy-media@api.service');
    expect(reads).toEqual([
      `/run/credentials/joy-media@api.service/${ENTITLEMENT_SIGNING_KEY_SYSTEMD_CREDENTIAL_ID}`,
    ]);
    expect(value).toBe(privateKeyPem);
  });

  it('returns undefined when the credential file does not exist', () => {
    const value = readEntitlementSigningKeyFromCredential(() => {
      throw new Error('ENOENT');
    });
    expect(value).toBeUndefined();
  });

  it('returns undefined for a present but empty credential file', () => {
    const value = readEntitlementSigningKeyFromCredential(() => '   \n');
    expect(value).toBeUndefined();
  });
});

describe('DisabledEntitlementSigner', () => {
  it('refuses to sign rather than fabricating an unpinnable key', () => {
    const signer = new DisabledEntitlementSigner();
    expect(signer.publicKeyPem).toBe('');
    expect(() => signer.sign(samplePayload())).toThrow(EntitlementSigningError);
  });
});
