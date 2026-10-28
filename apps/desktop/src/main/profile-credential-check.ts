import type { SecretStore } from '@joy-media/provider-sdk';
import type { LocalDatabase } from '../store/local-database.js';

/**
 * Startup check for stored provider keys (PLAN-v4 §9c, "unreadable DPAPI records").
 *
 * A profile whose key the secret store cannot return is marked `credential-unavailable`. It is
 * never deleted here: only an explicit user delete removes a profile. The check reads keys only
 * to confirm they are present and returns profile IDs only, never a key.
 */
export async function checkProfileCredentials(
  db: LocalDatabase,
  secretStore: SecretStore,
): Promise<readonly string[]> {
  const unavailable: string[] = [];
  for (const profile of db.listProviderProfiles()) {
    let present = false;
    try {
      present = (await secretStore.get(profile.secretHandleId)) !== null;
    } catch {
      present = false;
    }
    if (!present) {
      db.markProfileCredentialUnavailable(profile.id);
      unavailable.push(profile.id);
    }
  }
  return unavailable;
}
