import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * Signed release manifests (JOY Media desktop migration, wave 7). The desktop app's
 * auto-updater (`apps/desktop/src/main/auto-update-policy.ts`) verifies this signature before
 * trusting a release manifest fetched over the network — the same reasoning
 * entitlement-signing.ts documents: a compromised CDN or a DNS/TLS-interception attack can
 * serve a modified `GET /v1/releases/:channel` response, but cannot forge a signature without
 * this key.
 *
 * Deliberately a **separate** Ed25519 key pair from entitlement-signing.ts's signer: an
 * entitlement leak and a release-signing-key leak have very different blast radii (one lets an
 * attacker forge "this device has an active subscription"; the other lets an attacker forge
 * "install this binary"), so they must never share key material or a credential id.
 */

export interface ReleaseManifestPayload {
  readonly channel: 'stable' | 'beta';
  readonly version: string;
  readonly downloadUrl: string;
  readonly sha256: string;
  readonly minSupportedVersion?: string;
}

export interface SignedReleaseManifest {
  readonly payload: ReleaseManifestPayload;
  /** base64url Ed25519 signature over the canonical JSON encoding of `payload`. */
  readonly signature: string;
}

export class ReleaseSigningError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReleaseSigningError';
  }
}

export interface ReleaseSigner {
  sign(payload: ReleaseManifestPayload): SignedReleaseManifest;
  readonly publicKeyPem: string;
}

function canonicalize(payload: ReleaseManifestPayload): Buffer {
  return Buffer.from(
    JSON.stringify({
      channel: payload.channel,
      version: payload.version,
      downloadUrl: payload.downloadUrl,
      sha256: payload.sha256,
      ...(payload.minSupportedVersion !== undefined
        ? { minSupportedVersion: payload.minSupportedVersion }
        : {}),
    }),
    'utf8',
  );
}

export function createEd25519ReleaseSigner(privateKeyPem: string): ReleaseSigner {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch (error) {
    throw new ReleaseSigningError(
      'SIGNING_KEY_INVALID',
      `release signing key could not be parsed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new ReleaseSigningError(
      'SIGNING_KEY_INVALID',
      `release signing key must be Ed25519, got "${privateKey.asymmetricKeyType ?? 'unknown'}"`,
    );
  }
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: 'spki', format: 'pem' })
    .toString();

  return {
    publicKeyPem,
    sign(payload) {
      const signature = sign(null, canonicalize(payload), privateKey);
      return { payload, signature: signature.toString('base64url') };
    },
  };
}

/** Used when JOY_MEDIA_RELEASE_SIGNING_KEY is unset — signing a release manifest stays
 * disabled rather than ever using a generated-on-the-fly key the desktop app could never have
 * pinned. Same "disabled fallback, same interface" shape as DisabledEntitlementSigner. */
export class DisabledReleaseSigner implements ReleaseSigner {
  readonly publicKeyPem = '';
  sign(_payload: ReleaseManifestPayload): SignedReleaseManifest {
    throw new ReleaseSigningError('SIGNING_UNCONFIGURED', 'release signing key is not configured');
  }
}

export function verifyReleaseManifest(
  signed: SignedReleaseManifest,
  publicKeyPem: string,
): boolean {
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    return false;
  }
  try {
    return verify(
      null,
      canonicalize(signed.payload),
      publicKey,
      Buffer.from(signed.signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

/** Same systemd `LoadCredential=` directory `joy-media@api.service` already uses. Never
 * generated, never committed, never logged — provisioning the actual key file is an
 * out-of-band ops action for the owner/Codex. Deliberately a distinct credential id from
 * entitlement-signing.ts's — see the module doc on why the keys must never be shared. */
export const RELEASE_SIGNING_KEY_SYSTEMD_CREDENTIAL_ID = 'joy-media-release-signing-key';
const DEFAULT_RELEASE_SIGNING_KEY_CREDENTIAL_DIRECTORY = '/run/credentials/joy-media@api.service';

export function readReleaseSigningKeyFromCredential(
  readFile: (path: string, encoding: 'utf8') => string,
  directory = DEFAULT_RELEASE_SIGNING_KEY_CREDENTIAL_DIRECTORY,
): string | undefined {
  try {
    const value = readFile(`${directory}/${RELEASE_SIGNING_KEY_SYSTEMD_CREDENTIAL_ID}`, 'utf8');
    return value.trim() === '' ? undefined : value;
  } catch {
    return undefined;
  }
}
