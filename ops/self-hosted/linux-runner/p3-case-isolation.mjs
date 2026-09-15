import { createHash } from 'node:crypto';

export function p3CaseWorkspaceTitle({ candidateSha, runId, runAttempt, pass, caseId }) {
  const candidate = typeof candidateSha === 'string' ? candidateSha.slice(0, 12) : 'local';
  return `P3 ${candidate}-${runId}-${runAttempt}-p${pass} ${String(caseId).replaceAll('/', '-')}`;
}

export function hashEffectiveProjectState(state) {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

export function effectiveProjectStateMismatches(before, after) {
  const problems = [];
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  if (before?.projectId !== after?.projectId) problems.push('projectId');
  if (!equal(before?.timeline, after?.timeline)) problems.push('timeline');
  // A successful export persists the selected delivery preset and timestamp
  // as a visual-project snapshot. Compare the authored-content fingerprint
  // when the caller provides it, while retaining the coarse visual revision
  // check for older callers that do not capture that fingerprint.
  if (
    before?.visualAuthoredHash !== undefined && after?.visualAuthoredHash !== undefined
      ? before.visualAuthoredHash !== after.visualAuthoredHash
      : !equal(before?.visual, after?.visual)
  )
    problems.push('visual');
  if (before?.contentHash !== after?.contentHash) problems.push('contentHash');
  return problems;
}
