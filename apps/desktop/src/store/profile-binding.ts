import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { evaluateEndpoint } from '@joy-media/provider-sdk';

/** Ties a saved key to one endpoint (PLAN-v4 §6c item 6). A changed URL changes the digest. */
export function endpointBindingDigest(profileId: string, origin: string, basePath: string): string {
  return createHash('sha256')
    .update(JSON.stringify([profileId, origin, basePath]))
    .digest('hex');
}

interface UnboundRow {
  readonly id: string;
  readonly provider: string;
  readonly base_url: string;
}

/**
 * Binds every saved profile that has no binding yet, when the endpoint policy allows its URL. A
 * v1.0.x profile always saved its key together with its URL, so the stored URL is the one that key
 * was given for. Disabled legacy profiles stay unbound: they never connect. Safe to run on every
 * start, because it only touches profiles that have no binding.
 */
export function bindUnboundProfiles(db: DatabaseSync, now: string): number {
  const rows = db
    .prepare(
      `SELECT id, provider, base_url FROM provider_profiles
       WHERE id NOT IN (SELECT profile_id FROM profile_binding)
         AND id NOT IN (SELECT profile_id FROM profile_state WHERE state = 'disabled-legacy')`,
    )
    .all() as unknown as readonly UnboundRow[];
  let bound = 0;
  for (const row of rows) {
    const verdict = evaluateEndpoint(row.provider, row.base_url);
    if (!verdict.allowed) continue;
    db.prepare(
      'INSERT OR REPLACE INTO profile_binding (profile_id, binding_digest, updated_at) VALUES (?, ?, ?)',
    ).run(row.id, endpointBindingDigest(row.id, verdict.origin, verdict.basePath), now);
    bound += 1;
  }
  return bound;
}
