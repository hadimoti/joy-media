// Builds the receipt for one attended session (plan section 3.3). A receipt binds the result to the frozen candidate
// commit, the exe digest and the pre-registered thresholds, so a result can only be cited for the artifact it was
// measured on. The receipt holds step results and counts only. It never holds credentials, account identifiers or
// raw provider output, and a receipt that found a leak is refused.
export const RECEIPT_SCHEMA = 'joy-media.attended-receipt.v1';
export const ATTENDED_SESSIONS = ['G1', 'G2', 'A1'];

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const STEP_KEYS = new Set(['id', 'result', 'measurement', 'unit']);

/**
 * @param {{
 *   session: string, candidateSha: string, exeSha256: string, thresholdsSha256: string,
 *   startedUtc: string, finishedUtc: string,
 *   steps: Array<{ id: string, result: 'pass' | 'fail', measurement?: number | null, unit?: string }>,
 *   leakScan: { literalCount: number, counts: number[], filesScanned: number }
 * }} input
 */
export function buildReceipt(input) {
  if (!ATTENDED_SESSIONS.includes(input.session)) {
    throw new Error(`Unknown attended session "${input.session}".`);
  }
  if (!COMMIT_PATTERN.test(input.candidateSha))
    throw new Error('The candidate must be a full lowercase commit SHA.');
  if (!DIGEST_PATTERN.test(input.exeSha256))
    throw new Error('The exe digest must be a lowercase SHA-256.');
  if (!DIGEST_PATTERN.test(input.thresholdsSha256))
    throw new Error('The thresholds digest must be a lowercase SHA-256.');

  const started = Date.parse(input.startedUtc);
  const finished = Date.parse(input.finishedUtc);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    throw new Error('The session window must be two ISO times with the finish after the start.');
  }

  if (!Array.isArray(input.steps) || input.steps.length === 0)
    throw new Error('A receipt needs at least one step.');
  const steps = input.steps.map((step) => {
    for (const key of Object.keys(step)) {
      if (!STEP_KEYS.has(key)) throw new Error(`Step field "${key}" is not allowed in a receipt.`);
    }
    if (typeof step.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/u.test(step.id)) {
      throw new Error(`Step id "${step.id}" must be a short lowercase identifier.`);
    }
    if (step.result !== 'pass' && step.result !== 'fail')
      throw new Error(`Step ${step.id} must be pass or fail.`);
    if (
      step.measurement !== undefined &&
      step.measurement !== null &&
      !Number.isFinite(step.measurement)
    ) {
      throw new Error(`Step ${step.id} measurement must be a finite number.`);
    }
    return {
      id: step.id,
      result: step.result,
      measurement: step.measurement ?? null,
      unit: step.unit ?? null,
    };
  });

  const leak = input.leakScan;
  if (!leak || !Number.isInteger(leak.literalCount) || leak.literalCount < 1) {
    throw new Error('The leak scan must cover at least one literal.');
  }
  if (!Array.isArray(leak.counts) || leak.counts.length !== leak.literalCount) {
    throw new Error('The leak scan counts must match the literal count.');
  }
  const hits = leak.counts.reduce((sum, count) => sum + count, 0);
  if (hits > 0) {
    // A receipt that found a secret is not written at all, so no copy of the leak can be published.
    throw new Error(`The leak scan found ${hits} occurrence(s). The receipt was not written.`);
  }

  const accepted = steps.every((step) => step.result === 'pass');
  return {
    schema: RECEIPT_SCHEMA,
    session: input.session,
    candidate: { commitSha: input.candidateSha, exeSha256: input.exeSha256 },
    thresholdsSha256: input.thresholdsSha256,
    window: { startedUtc: input.startedUtc, finishedUtc: input.finishedUtc },
    steps,
    leakScan: { literalCount: leak.literalCount, hits: 0, filesScanned: leak.filesScanned },
    verdict: accepted ? 'accepted' : 'not-accepted',
  };
}

export function serializeReceipt(receipt) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}
