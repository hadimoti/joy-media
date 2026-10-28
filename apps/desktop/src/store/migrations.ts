import { bindUnboundProfiles } from './profile-binding.js';
import type { DatabaseSync } from 'node:sqlite';

/**
 * v1.1.0 desktop migrations (PLAN-v4 §9a and §9c).
 *
 * The schema change is additive: two new tables, and the v1.0.x tables and rows are not
 * altered, so a downgrade to v1.0.x keeps working and simply ignores the new tables.
 *
 * Two kinds of work run here:
 * - one-time steps, each in its own transaction, with a `migration_state` marker written in
 *   the same transaction. A step that has finished is skipped on later starts;
 * - the legacy-profile reconciliation, which runs on every start. A v1.0.x rollback can create
 *   a kilo or joy-hosted profile after the upgrade has already run, so the check cannot be a
 *   one-time step. It only inserts rows for profiles that have no state yet, so it is idempotent.
 *
 * A crash or error part-way through any transaction rolls it back, and the next start runs it
 * again from the beginning.
 */

/** Provider IDs that v1.0.x could save and that v1.1.0 no longer offers (§9a). */
export const LEGACY_PROVIDER_IDS: readonly string[] = ['kilo', 'joy-hosted'];

/**
 * - `active`: usable as before. A profile with no state row is active.
 * - `disabled-legacy`: a v1.0.x profile for a provider v1.1.0 no longer offers. It is shown
 *   disabled and is never deleted automatically.
 * - `credential-unavailable`: the secret store could not return the key (for example an
 *   unreadable DPAPI record). The profile is kept, never deleted automatically, and is marked.
 */
export type ProfileState = 'active' | 'disabled-legacy' | 'credential-unavailable';

/** The user's deferred choice. "Later" keeps a profile disabled and survives restarts. */
export type ProfileDecision = 'later';

export interface ProfileStateRecord {
  readonly profileId: string;
  readonly state: ProfileState;
  readonly decision?: ProfileDecision | undefined;
  readonly updatedAt: string;
}

export interface MigrationOptions {
  readonly now: () => string;
  /** Test hook: called after each profile row a step writes, so a test can fail mid-step. */
  readonly afterStepRow?: (stepId: string, profileId: string) => void;
}

interface OneTimeStep {
  readonly id: string;
  readonly run: (db: DatabaseSync, options: MigrationOptions) => void;
}

const ONE_TIME_STEPS: readonly OneTimeStep[] = [
  {
    id: 'v110.bind-legacy-profiles',
    // A v1.0.x profile was saved with its key and its URL together, so its stored URL is the one
    // the key was given for. Bound once, here, when the endpoint policy allows that URL (§6c, §9a).
    run: (db) => {
      bindUnboundProfiles(db, new Date().toISOString());
    },
  },
  {
    id: 'v110.update-settings-ignored',
    // Nothing to write. Update settings from v1.0.x are ignored by v1.1.0 and are not deleted,
    // so this step only records that the rule has been applied (§9c).
    run: () => undefined,
  },
];

/** Creates the additive tables. Safe to call on every start. */
export function ensureMigrationSchema(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS migration_state (
       step TEXT PRIMARY KEY,
       done_at TEXT NOT NULL
     )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS profile_state (
       profile_id TEXT PRIMARY KEY,
       state TEXT NOT NULL,
       decision TEXT,
       updated_at TEXT NOT NULL
     )`,
  );
}

/**
 * Marks every legacy profile that has no state row yet as `disabled-legacy`. Returns the IDs it
 * marked. Runs in one transaction: a failure part-way through rolls the whole pass back.
 */
export function reconcileLegacyProfiles(
  db: DatabaseSync,
  options: MigrationOptions,
): readonly string[] {
  const pending = db
    .prepare(
      `SELECT id FROM provider_profiles
        WHERE provider IN (${LEGACY_PROVIDER_IDS.map(() => '?').join(', ')})
          AND id NOT IN (SELECT profile_id FROM profile_state)
        ORDER BY id ASC`,
    )
    .all(...LEGACY_PROVIDER_IDS) as unknown as readonly { id: string }[];
  if (pending.length === 0) return [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare(
      `INSERT INTO profile_state (profile_id, state, decision, updated_at)
       VALUES (?, 'disabled-legacy', NULL, ?)`,
    );
    for (const row of pending) {
      insert.run(row.id, options.now());
      options.afterStepRow?.('v110.legacy-profiles', row.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return pending.map((row) => row.id);
}

/**
 * Runs every one-time step that has not finished yet, each in its own transaction, then the
 * legacy-profile reconciliation. Returns what it did, for tests and logs. A second call that
 * finds nothing to do returns an empty list.
 */
export function runMigrations(db: DatabaseSync, options: MigrationOptions): readonly string[] {
  ensureMigrationSchema(db);
  const ran: string[] = [];
  for (const step of ONE_TIME_STEPS) {
    const done = db.prepare('SELECT step FROM migration_state WHERE step = ?').get(step.id) as
      { step: string } | undefined;
    if (done !== undefined) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      step.run(db, options);
      // The marker records real time. It does not use the injected clock, so starting the
      // database never shifts the timestamps that the rest of the database uses.
      db.prepare('INSERT INTO migration_state (step, done_at) VALUES (?, ?)').run(
        step.id,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      ran.push(step.id);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  if (reconcileLegacyProfiles(db, options).length > 0) ran.push('v110.legacy-profiles');
  return ran;
}

/** Returns the recorded state for every profile that has one. Profiles without a row are active. */
export function listProfileStates(db: DatabaseSync): readonly ProfileStateRecord[] {
  const rows = db
    .prepare(
      'SELECT profile_id, state, decision, updated_at FROM profile_state ORDER BY profile_id ASC',
    )
    .all() as unknown as readonly {
    profile_id: string;
    state: ProfileState;
    decision: ProfileDecision | null;
    updated_at: string;
  }[];
  return rows.map((row) => ({
    profileId: row.profile_id,
    state: row.state,
    ...(row.decision === null ? {} : { decision: row.decision }),
    updatedAt: row.updated_at,
  }));
}

/** Records "Later": the profile stays disabled and the choice persists across restarts. */
export function recordLaterDecision(db: DatabaseSync, profileId: string, now: string): void {
  db.prepare(
    `INSERT INTO profile_state (profile_id, state, decision, updated_at)
     VALUES (?, 'disabled-legacy', 'later', ?)
     ON CONFLICT(profile_id) DO UPDATE SET decision = 'later', updated_at = excluded.updated_at`,
  ).run(profileId, now);
}

/**
 * Marks a profile whose key the secret store could not return. The row is kept and the profile
 * is never deleted automatically. Only an explicit user delete removes it. A legacy profile keeps
 * its disabled state, which does not depend on its key.
 */
export function markCredentialUnavailable(db: DatabaseSync, profileId: string, now: string): void {
  db.prepare(
    `INSERT INTO profile_state (profile_id, state, decision, updated_at)
     VALUES (?, 'credential-unavailable', NULL, ?)
     ON CONFLICT(profile_id) DO UPDATE SET
       state = CASE WHEN profile_state.state = 'disabled-legacy' THEN 'disabled-legacy'
                    ELSE 'credential-unavailable' END,
       updated_at = excluded.updated_at`,
  ).run(profileId, now);
}

/** Clears the credential mark once the key reads again, or the profile is saved again. */
export function clearCredentialUnavailable(db: DatabaseSync, profileId: string): void {
  db.prepare(
    "DELETE FROM profile_state WHERE profile_id = ? AND state = 'credential-unavailable'",
  ).run(profileId);
}

/** Removes the state row when the user explicitly deletes a profile. */
export function forgetProfileState(db: DatabaseSync, profileId: string): void {
  db.prepare('DELETE FROM profile_state WHERE profile_id = ?').run(profileId);
}
