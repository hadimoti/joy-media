/**
 * The offline-smoke receipt for the packaged Windows app (plan section 8b, schema joy-media.offline-smoke/1).
 *
 * The packaged app is launched, opened, used for an export and run through its CLI, with network egress recorded
 * per process. The gate accepts the receipt only when it binds to the exact candidate and artifact, comes from the
 * first attempt of a fresh run, records zero egress for every process and passes every step. A missing, unreadable,
 * mismatched, stale or failed receipt is refused, and every reason is named.
 */

export const OFFLINE_SMOKE_SCHEMA = 'joy-media.offline-smoke/1';

/** The steps the receipt must record, each exactly once, in any order. */
export const OFFLINE_SMOKE_STEP_IDS: readonly string[] = ['launch', 'open', 'export', 'cli'];

/** The processes whose egress must be zero. */
export const OFFLINE_SMOKE_EGRESS_KEYS: readonly string[] = ['main', 'renderer', 'worker', 'cli'];

export interface OfflineSmokeRunWindow {
  /** ISO 8601 UTC instant at which the run began. */
  readonly start: string;
  /** ISO 8601 UTC instant at which the run may have ended. */
  readonly end: string;
}

/** What the receipt must bind to. The caller takes the artifact digest from the candidate's SHA256SUMS.txt line. */
export interface OfflineSmokeExpectation {
  readonly candidateSha: string;
  readonly artifactName: string;
  readonly artifactSha256: string;
  readonly runWindow: OfflineSmokeRunWindow;
}

export interface OfflineSmokeResult {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA64 = /^[0-9a-f]{64}$/u;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function artifactReasons(artifact: unknown, expected: OfflineSmokeExpectation): string[] {
  if (!isRecord(artifact)) return ['artifact is missing'];
  const reasons: string[] = [];
  if (artifact.name !== expected.artifactName) {
    reasons.push('artifact.name is not the candidate artifact');
  }
  if (artifact.sha256 !== expected.artifactSha256) {
    reasons.push('artifact.sha256 is not the SHA256SUMS.txt line for the candidate artifact');
  }
  return reasons;
}

function freshnessReasons(
  receipt: Record<string, unknown>,
  window: OfflineSmokeRunWindow,
): string[] {
  const reasons: string[] = [];
  const instants: Record<string, number> = {};
  for (const name of ['builtAt', 'startedAt', 'finishedAt']) {
    const value = receipt[name];
    if (typeof value !== 'string' || !UTC_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
      reasons.push(`${name} is not a UTC timestamp`);
    } else {
      instants[name] = Date.parse(value);
    }
  }
  if (reasons.length > 0) return reasons;
  if (!(instants.builtAt <= instants.startedAt && instants.startedAt <= instants.finishedAt)) {
    reasons.push(
      'the timestamps are out of order: builtAt, startedAt and finishedAt must not decrease',
    );
  }
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  for (const [name, value] of Object.entries(instants)) {
    if (value < start || value > end) reasons.push(`${name} is outside the run window`);
  }
  return reasons;
}

function stepReasons(steps: unknown): string[] {
  if (!Array.isArray(steps)) return ['steps is not a list'];
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (
      !isRecord(step) ||
      typeof step.id !== 'string' ||
      !OFFLINE_SMOKE_STEP_IDS.includes(step.id)
    ) {
      reasons.push('a step has an unknown id');
      continue;
    }
    if (seen.has(step.id)) reasons.push(`step ${step.id} appears more than once`);
    seen.add(step.id);
    if (step.result !== 'pass') reasons.push(`step ${step.id} did not pass`);
  }
  for (const id of OFFLINE_SMOKE_STEP_IDS) {
    if (!seen.has(id)) reasons.push(`step ${id} is missing`);
  }
  return reasons;
}

function egressReasons(egress: unknown): string[] {
  if (!isRecord(egress)) return ['egress is missing'];
  const reasons: string[] = [];
  for (const key of OFFLINE_SMOKE_EGRESS_KEYS) {
    if (egress[key] !== 0) reasons.push(`egress.${key} is not zero`);
  }
  if (typeof egress.netLogSha256 !== 'string' || !SHA64.test(egress.netLogSha256)) {
    reasons.push('egress.netLogSha256 is not a 64-character lowercase hex digest');
  }
  return reasons;
}

/** Checks a parsed receipt against what the gate expects. Every failed rule adds a reason. */
export function validateOfflineSmokeReceipt(
  receipt: unknown,
  expected: OfflineSmokeExpectation,
): OfflineSmokeResult {
  if (!isRecord(receipt)) {
    return { ok: false, reasons: ['the receipt is not a JSON object'] };
  }
  const reasons: string[] = [];
  if (receipt.schema !== OFFLINE_SMOKE_SCHEMA)
    reasons.push(`schema is not ${OFFLINE_SMOKE_SCHEMA}`);
  if (receipt.candidateSha !== expected.candidateSha) {
    reasons.push('candidateSha is not the validated candidate');
  }
  if (typeof receipt.workflowSha !== 'string' || !SHA40.test(receipt.workflowSha)) {
    reasons.push('workflowSha is not a 40-character lowercase hex SHA');
  }
  if (typeof receipt.runId !== 'string' || receipt.runId.length === 0)
    reasons.push('runId is missing');
  if (receipt.attempt !== 1) reasons.push('attempt is not 1, so a re-run is refused');
  reasons.push(...artifactReasons(receipt.artifact, expected));
  reasons.push(...freshnessReasons(receipt, expected.runWindow));
  reasons.push(...stepReasons(receipt.steps));
  reasons.push(...egressReasons(receipt.egress));
  if (receipt.verdict !== 'pass') {
    reasons.push(receipt.verdict === 'fail' ? 'verdict is fail' : 'verdict is not pass');
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * The gate's entry point for a receipt file. An absent file, one that is not valid JSON, and one that fails the
 * checks are all refused, each with its own reason.
 */
export function validateOfflineSmokeReceiptText(
  text: string | undefined,
  expected: OfflineSmokeExpectation,
): OfflineSmokeResult {
  if (text === undefined) {
    return { ok: false, reasons: ['the offline-smoke receipt is missing'] };
  }
  let receipt: unknown;
  try {
    receipt = JSON.parse(text);
  } catch {
    return { ok: false, reasons: ['the offline-smoke receipt is not valid JSON'] };
  }
  return validateOfflineSmokeReceipt(receipt, expected);
}
