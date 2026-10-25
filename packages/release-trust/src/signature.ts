import { createPublicKey, verify as verifySignature } from 'node:crypto';

const ED25519_SIGNATURE_BYTES = 64;

/**
 * Verifies a detached Ed25519 signature over the exact bytes of a release manifest. The bytes are what the owner
 * signed, so no re-serialisation or parser difference can change what is trusted.
 *
 * More than one key may be pinned, so a key can rotate: a manifest signed by any pinned key is accepted. With no
 * pinned key, or with a key that is not Ed25519, nothing verifies.
 */
export function verifyReleaseManifestSignature(options: {
  readonly manifest: Uint8Array;
  readonly signature: string;
  readonly publicKeysPem: readonly string[];
}): boolean {
  const signature = decodeSignature(options.signature);
  if (signature === undefined) return false;
  return options.publicKeysPem.some((pem) => {
    try {
      const key = createPublicKey(pem);
      return (
        key.asymmetricKeyType === 'ed25519' &&
        verifySignature(null, options.manifest, key, signature)
      );
    } catch {
      return false;
    }
  });
}

/** The signature file holds the base64url text and one line break. That is the only accepted shape. */
export function parseSignatureText(text: string): string {
  return text.replace(/\r?\n$/u, '');
}

/** Ed25519 signatures are 64 raw bytes, written in unpadded base64url. Anything else is refused. */
function decodeSignature(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === ED25519_SIGNATURE_BYTES ? bytes : undefined;
}
