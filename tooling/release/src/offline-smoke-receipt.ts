import { createHash } from 'node:crypto';

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

export interface OfflineSmokeReceiptContext {
  readonly candidateSha: string;
  readonly workflowSha: string;
  readonly runId: string;
  readonly attempt: number;
  readonly artifactName: string;
  readonly artifactSha256: string;
  readonly builtAt: string;
}

export interface OfflineSmokeStepEvidence {
  readonly id: string;
  readonly result: 'pass' | 'fail';
  readonly detail?: string;
}

export interface OfflineSmokeNetworkEvidence {
  readonly networkingDisabled: boolean;
  readonly adapterPresent: boolean;
  readonly adapterCount: number;
  readonly reason: string;
}

export interface OfflineSmokeRunEvidence {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly steps: readonly OfflineSmokeStepEvidence[];
  readonly network: OfflineSmokeNetworkEvidence;
}

/** Builds the gate receipt from Sandbox evidence; zero counters are justified only by isolation evidence. */
export function createOfflineSmokeReceipt(
  context: OfflineSmokeReceiptContext,
  evidence: OfflineSmokeRunEvidence,
  networkLog: string,
): Record<string, unknown> {
  if (
    evidence.network.networkingDisabled !== true ||
    evidence.network.adapterPresent !== false ||
    evidence.network.adapterCount !== 0 ||
    evidence.network.reason.trim() === ''
  ) {
    throw new Error(
      'zero egress requires disabled Sandbox networking and an absent network adapter',
    );
  }
  if (networkLog.trim() === '') throw new Error('network evidence log is empty');

  const allPassed = evidence.steps.every((step) => step.result === 'pass');
  return {
    schema: OFFLINE_SMOKE_SCHEMA,
    candidateSha: context.candidateSha,
    workflowSha: context.workflowSha,
    runId: context.runId,
    attempt: context.attempt,
    artifact: { name: context.artifactName, sha256: context.artifactSha256 },
    builtAt: context.builtAt,
    startedAt: evidence.startedAt,
    finishedAt: evidence.finishedAt,
    steps: evidence.steps,
    egress: {
      main: 0,
      renderer: 0,
      worker: 0,
      cli: 0,
      netLogSha256: createHash('sha256').update(networkLog, 'utf8').digest('hex'),
      reason:
        'Zero by construction: Windows Sandbox networking was disabled and its adapter was absent.',
    },
    network: evidence.network,
    verdict: allPassed ? 'pass' : 'fail',
  };
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
  if (typeof egress.reason !== 'string' || egress.reason.trim() === '') {
    reasons.push('egress zero-by-construction reason is missing');
  }
  return reasons;
}

function networkReasons(network: unknown): string[] {
  if (!isRecord(network)) return ['Sandbox network evidence is missing'];
  const reasons: string[] = [];
  if (network.networkingDisabled !== true) {
    reasons.push('Sandbox networking was not recorded as disabled');
  }
  if (network.adapterPresent !== false || network.adapterCount !== 0) {
    reasons.push('Sandbox network adapter was present');
  }
  if (typeof network.reason !== 'string' || network.reason.trim() === '') {
    reasons.push('Sandbox network evidence reason is missing');
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
  reasons.push(...networkReasons(receipt.network));
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
