/**
 * Classification for a leaked CI namespace, keyed off the owning workflow run's
 * status. Split out so it can be unit-tested without the janitor's Postgres /
 * MinIO side effects.
 *
 * Sweep eligibility is deliberately narrow. Deleting a namespace requires PROOF
 * that (a) it is run-owned by CI and (b) that run is finished:
 *
 *   current     -> the current run's own namespace. Never touched.
 *   active      -> owning run is in_progress / queued / waiting. Never touched.
 *   orphan      -> owning run status is exactly "completed". SWEEPABLE.
 *   not-found   -> the GitHub API returned 404 for the run id. This is NOT proof
 *                  of a completed CI run — it can also be a purged/very old run,
 *                  a hand-created or malformed namespace, or a token/permission
 *                  gap — so it is quarantined in its own class and NEVER swept.
 *   unknown     -> status could not be read (network, http error, missing repo
 *                  or token). Never touched.
 */
export function classifyRun(run) {
  const status = run?.status;
  if (status === 'current') return 'current';
  if (status === 'in_progress' || status === 'queued' || status === 'waiting') return 'active';
  if (status === 'completed') return 'orphan';
  if (status === 'not-found') return 'not-found';
  return 'unknown';
}

/** The only class the janitor may delete in --sweep mode. */
export function isSweepable(classification) {
  return classification === 'orphan';
}
