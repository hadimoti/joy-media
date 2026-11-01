import { createHash } from 'node:crypto';

/** Ties a saved key to one endpoint (PLAN-v4 §6c item 6). A changed URL changes the digest. */
export function endpointBindingDigest(profileId: string, origin: string, basePath: string): string {
  return createHash('sha256')
    .update(JSON.stringify([profileId, origin, basePath]))
    .digest('hex');
}

/**
 * Identifies one stored key by its ciphertext. A different key gives different ciphertext, so a
 * write of another key, by this build or an older one, changes the digest and the binding no longer
 * matches. Nothing is derived from the key itself (PLAN-v4 §6c item 6).
 */
export function secretVersionDigest(ciphertextBase64: string | undefined): string {
  return createHash('sha256')
    .update(ciphertextBase64 ?? '')
    .digest('hex');
}

/** The binding table, as v1.1.0 creates it. Each row ties a profile to its endpoint and key version. */
export const PROFILE_BINDING_TABLE_SQL = `CREATE TABLE IF NOT EXISTS profile_binding (
  profile_id TEXT PRIMARY KEY,
  binding_digest TEXT NOT NULL,
  secret_digest TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;
