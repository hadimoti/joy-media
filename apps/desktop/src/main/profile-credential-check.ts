import type { SecretStore } from '@joy-media/provider-sdk';
import type { LocalDatabase } from '../store/local-database.js';

/**
 * Startup check for stored provider keys (PLAN-v4 §9c, "unreadable DPAPI records").
 *
 * A profile whose key the secret store cannot return is marked `credential-unavailable`, and
 * a profile whose key reads again has that mark cleared. A legacy profile is not checked, because
 * it is disabled whatever its key does. Nothing is deleted here: only an explicit user delete
 * removes a profile. The check reads keys only to confirm they are present, and it returns profile
 * IDs only, never a key.
 */
export async function checkProfileCredentials(
  db: LocalDatabase,
  secretStore: SecretStore,
): Promise<readonly string[]> {
  const states = new Map(
    db.listProfileStates().map((record) => [record.profileId, record.state] as const),
  );
  const unavailable: string[] = [];
  for (const profile of db.listProviderProfiles()) {
    if (states.get(profile.id) === 'disabled-legacy') continue;
    let present = false;
    try {
      present = (await secretStore.get(profile.secretHandleId)) !== null;
    } catch {
      present = false;
    }
    if (present) {
      db.clearProfileCredentialUnavailable(profile.id);
    } else {
      db.markProfileCredentialUnavailable(profile.id);
      unavailable.push(profile.id);
    }
  }
  return unavailable;
}
