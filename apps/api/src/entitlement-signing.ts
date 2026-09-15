import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * Signed, time-bounded device/session entitlements (JOY Media desktop migration, wave 4;
 * locked owner decision: "Device/session entitlements must be signed, time-bounded,
 * revocable, and safe under clock rollback/offline use").
 *
 * Ed25519 via `node:crypto` — no external JWT library: the token shape here is a plain,
 * auditable `{payload, signature}` JSON object rather than a compact encoded string, since it
 * only ever needs to survive one JSON response body and a local file on the desktop side, not
 * a URL or header. Small and easy to read end-to-end beats reusing a general-purpose JWT
 * library for a one-message-type protocol.
 */

export type EntitlementPlan = 'monthly' | 'yearly' | 'none';
export type EntitlementSubscriptionStatus = 'active' | 'expired' | 'none';

export interface EntitlementPayload {
  readonly deviceId: string;
  readonly ownerId: string;
  readonly plan: EntitlementPlan;
  readonly subscriptionStatus: EntitlementSubscriptionStatus;
  /** Unix milliseconds. The server's own clock, not the client's — see the module doc on
   * clock-rollback safety: a desktop client verifying offline anchors its own rollback check
   * to this value, never to its own possibly-adjusted system clock alone. */
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface SignedEntitlement {
  readonly payload: EntitlementPayload;
  /** base64url Ed25519 signature over the canonical JSON encoding of `payload`. */
  readonly signature: string;
}

export class EntitlementSigningError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EntitlementSigningError';
  }
}

export interface EntitlementSigner {
  sign(payload: EntitlementPayload): SignedEntitlement;
  /** SPKI PEM. Safe to serve publicly — see release-metadata-service.ts's public-key route. */
  readonly publicKeyPem: string;
}

/** Stable key order so the same logical payload always canonicalizes identically — required
 * for a signature to verify regardless of how the caller happened to construct the object. */
function canonicalize(payload: EntitlementPayload): Buffer {
  return Buffer.from(
    JSON.stringify({
      deviceId: payload.deviceId,
      ownerId: payload.ownerId,
      plan: payload.plan,
      subscriptionStatus: payload.subscriptionStatus,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
    }),
    'utf8',
  );
}

export function createEd25519EntitlementSigner(privateKeyPem: string): EntitlementSigner {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch (error) {
    throw new EntitlementSigningError(
      'SIGNING_KEY_INVALID',
      `entitlement signing key could not be parsed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new EntitlementSigningError(
      'SIGNING_KEY_INVALID',
      `entitlement signing key must be Ed25519, got "${privateKey.asymmetricKeyType ?? 'unknown'}"`,
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

/** Used when JOY_MEDIA_ENTITLEMENT_SIGNING_KEY is unset — issuance stays disabled rather than
 * ever signing with a generated-on-the-fly (and therefore unpinnable by the desktop client)
 * key. Same "disabled fallback, same interface" shape as DisabledMediaAuth. */
export class DisabledEntitlementSigner implements EntitlementSigner {
  readonly publicKeyPem = '';
  sign(_payload: EntitlementPayload): SignedEntitlement {
    throw new EntitlementSigningError(
      'SIGNING_UNCONFIGURED',
      'entitlement signing key is not configured',
    );
  }
}

/** Same systemd `LoadCredential=` directory `joy-media@api.service` already loads its other
 * secrets from (see stock-video-credentials.ts's `DEFAULT_STOCK_VIDEO_CREDENTIAL_DIRECTORY` —
 * duplicated here as a literal rather than imported, to keep this file's only dependency on
 * that module's naming, not its stock-video-specific exports). Provisioning the actual key
 * file via `systemctl edit joy-media@api.service` / `LoadCredential=` is an out-of-band ops
 * action for the owner/Codex; this repository change only adds the code that reads it if
 * present. Never generated, never committed, never logged.
 */
export const ENTITLEMENT_SIGNING_KEY_SYSTEMD_CREDENTIAL_ID = 'joy-media-entitlement-signing-key';
const DEFAULT_ENTITLEMENT_SIGNING_KEY_CREDENTIAL_DIRECTORY =
  '/run/credentials/joy-media@api.service';

export function readEntitlementSigningKeyFromCredential(
  readFile: (path: string, encoding: 'utf8') => string,
  directory = DEFAULT_ENTITLEMENT_SIGNING_KEY_CREDENTIAL_DIRECTORY,
): string | undefined {
  try {
    const value = readFile(`${directory}/${ENTITLEMENT_SIGNING_KEY_SYSTEMD_CREDENTIAL_ID}`, 'utf8');
    return value.trim() === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

export function verifyEntitlement(signed: SignedEntitlement, publicKeyPem: string): boolean {
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
