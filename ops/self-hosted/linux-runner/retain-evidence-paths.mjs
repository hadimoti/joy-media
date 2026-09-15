import { join } from 'node:path';

/**
 * Mirrors the destination-path line in ops/self-hosted/linux-runner/retain-evidence.sh:
 *   dest="$persist_root/$CANDIDATE_SHA/${RUN}-${ATTEMPT}-p${PASS}"
 * Pure path composition only — no I/O, no shell.
 */
export function composeRetainedDestination(persistRoot, candidateSha, run, attempt, pass) {
  return join(persistRoot, candidateSha, `${run}-${attempt}-p${pass}`);
}
