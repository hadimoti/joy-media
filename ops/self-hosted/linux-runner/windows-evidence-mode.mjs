// Whether the real-service harness must find the Windows Worker evidence before its pass completes (plan section 3.4).
//
// release-candidate-v3 sets JOY_MEDIA_CI_WINDOWS_EVIDENCE=deferred. Its real-service pass then does not wait for the Windows lane,
// and the final gate still requires and binds the Windows evidence: restore-retained-evidence.mjs refuses an absent, foreign or
// malformed Windows receipt. Every other caller, including release-candidate-v2, keeps the strict check. An unknown mode fails
// closed, so a typo can never switch the check off.
export const WINDOWS_EVIDENCE_MODE_ENV = 'JOY_MEDIA_CI_WINDOWS_EVIDENCE';

export function windowsEvidenceRequired(env) {
  const mode = env[WINDOWS_EVIDENCE_MODE_ENV];
  if (mode === undefined || mode === '' || mode === 'required') return true;
  if (mode === 'deferred') return false;
  throw new Error(`unknown ${WINDOWS_EVIDENCE_MODE_ENV} mode: ${mode}`);
}
