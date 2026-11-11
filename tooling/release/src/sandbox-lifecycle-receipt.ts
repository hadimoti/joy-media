/**
 * Receipts for the Windows Sandbox installed-lifecycle runs of the local-only release gate.
 *
 * Two scripted runs write them (tooling/release/sandbox): the clean lifecycle (install, open, close,
 * uninstall) and the upgrade (v1.0.2 installed and run, then the candidate over it, then uninstall).
 * A receipt is accepted only when it names the Sandbox identity, binds to the candidate's setup
 * digest, and every required step passed. Anything missing, failed, or unexpected is a blocker.
 */

export const SANDBOX_LIFECYCLE_SCHEMA = 'joy-media.sandbox-lifecycle/1';
export const SANDBOX_UPGRADE_SCHEMA = 'joy-media.sandbox-upgrade/1';
export const SANDBOX_USER = 'WDAGUtilityAccount';

/** Steps the clean lifecycle run must report as passed, by id. */
export const REQUIRED_LIFECYCLE_STEPS: readonly string[] = [
  'sandbox-identity',
  'setup-digest',
  'control-signed-program',
  'install-silent',
  'installed',
  'open-window',
  'close-app',
  'no-process-after-close',
  'uninstall',
  'folder-removed',
];

/** Steps the upgrade run must report as passed, by id. */
export const REQUIRED_UPGRADE_STEPS: readonly string[] = [
  'sandbox-identity',
  'v102-zip-digest',
  'new-setup-digest',
  'v102-install',
  'v102-open-window',
  'v102-close',
  'v102-no-process-left',
  'new-install-over',
  'stale-files-from-v102',
  'data-marker-kept',
  'data-files-lost',
  'v110-open-window',
  'v110-still-running',
  'v110-close',
  'v110-no-process-left',
  'uninstall',
  'folder-removed',
];

export interface SandboxReceiptExpectation {
  /** SHA-256 (lowercase hex) of the candidate's joy-media-setup.exe. */
  readonly setupSha256: string;
  /** Version the installed package must report after the upgrade. Used by the upgrade receipt. */
  readonly version?: string;
}

const HEX64 = /^[0-9a-f]{64}$/u;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface Step {
  readonly id: string;
  readonly result: string;
  readonly detail: string;
}

function stepsOf(record: Record<string, unknown>, blockers: string[]): Map<string, Step> {
  const byId = new Map<string, Step>();
  if (!Array.isArray(record.steps)) {
    blockers.push('steps are missing');
    return byId;
  }
  for (const raw of record.steps) {
    const step = asRecord(raw);
    if (step === undefined || typeof step.id !== 'string') {
      blockers.push('a step is malformed');
      continue;
    }
    if (byId.has(step.id)) blockers.push(`step ${step.id} appears twice`);
    byId.set(step.id, {
      id: step.id,
      result: String(step.result),
      detail: typeof step.detail === 'string' ? step.detail : '',
    });
  }
  return byId;
}

function commonChecks(
  record: Record<string, unknown>,
  schema: string,
  required: readonly string[],
  digestStepId: string,
  expected: SandboxReceiptExpectation,
  blockers: string[],
): Map<string, Step> {
  if (record.schema !== schema) blockers.push(`schema must be ${schema}`);
  if (!HEX64.test(expected.setupSha256)) {
    blockers.push('the expected setup digest is not a SHA-256');
  }
  const identity = asRecord(record.identity);
  if (identity === undefined || identity.user !== SANDBOX_USER) {
    blockers.push(`the run must report the ${SANDBOX_USER} Sandbox user`);
  }
  const started = Date.parse(String(record.startedAt));
  const finished = Date.parse(String(record.finishedAt));
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    blockers.push('run times are missing or out of order');
  }
  const steps = stepsOf(record, blockers);
  for (const id of required) {
    const step = steps.get(id);
    if (step === undefined) blockers.push(`step ${id} is missing`);
    else if (step.result !== 'pass') blockers.push(`step ${id} did not pass`);
  }
  for (const step of steps.values()) {
    if (step.id === 'error') blockers.push('the run recorded an error step');
    else if (step.result !== 'pass') blockers.push(`step ${step.id} did not pass`);
  }
  const digest = steps.get(digestStepId);
  if (digest !== undefined && digest.detail.toLowerCase() !== expected.setupSha256) {
    blockers.push('the run installed a setup that is not the candidate setup');
  }
  return steps;
}

function snapshotOf(record: Record<string, unknown>, name: string): Record<string, unknown> {
  return asRecord(record[name]) ?? {};
}

/** Returns the reasons the clean-lifecycle receipt must be refused. An empty list means accepted. */
export function validateSandboxLifecycle(
  value: unknown,
  expected: SandboxReceiptExpectation,
): string[] {
  const record = asRecord(value);
  if (record === undefined) return ['receipt is not a JSON object'];
  const blockers: string[] = [];
  commonChecks(
    record,
    SANDBOX_LIFECYCLE_SCHEMA,
    REQUIRED_LIFECYCLE_STEPS,
    'setup-digest',
    expected,
    blockers,
  );
  const before = snapshotOf(record, 'beforeInstall');
  if (before.installFolderExists !== false)
    blockers.push('the Sandbox was not clean before the install');
  const installed = snapshotOf(record, 'afterInstall');
  if (installed.installFolderExists !== true || Number(installed.installFileCount) <= 0) {
    blockers.push('the install did not create the install folder');
  }
  if (installed.uninstallKey !== true) blockers.push('the install did not register an uninstaller');
  const removed = snapshotOf(record, 'afterUninstall');
  if (removed.installFolderExists !== false)
    blockers.push('the install folder is still there after the uninstall');
  if (removed.uninstallKey !== false)
    blockers.push('the uninstaller registration is still there after the uninstall');
  if (removed.pathHasJoy !== false)
    blockers.push('a JOY Media entry is still on the user PATH after the uninstall');
  if (removed.desktopShortcut !== false || removed.startMenuShortcut !== false) {
    blockers.push('a shortcut is still there after the uninstall');
  }
  return blockers;
}

/** Returns the reasons the upgrade receipt must be refused. An empty list means accepted. */
export function validateSandboxUpgrade(
  value: unknown,
  expected: SandboxReceiptExpectation,
): string[] {
  const record = asRecord(value);
  if (record === undefined) return ['receipt is not a JSON object'];
  const blockers: string[] = [];
  commonChecks(
    record,
    SANDBOX_UPGRADE_SCHEMA,
    REQUIRED_UPGRADE_STEPS,
    'new-setup-digest',
    expected,
    blockers,
  );
  const version = expected.version ?? '1.1.0';
  const first = snapshotOf(record, 'S1-v102-installed');
  if (first.appPackageVersion !== '1.0.2') blockers.push('the first install was not v1.0.2');
  const upgraded = snapshotOf(record, 'S3-upgraded');
  if (upgraded.appPackageVersion !== version)
    blockers.push(`the upgrade did not leave version ${version}`);
  if (upgraded.uninstallDisplayVersion !== version) {
    blockers.push(`the uninstaller registration does not say ${version} after the upgrade`);
  }
  const data = snapshotOf(record, 'S4-v110-after-run');
  if (data.dataFolderExists !== true)
    blockers.push('the app data folder is gone after the upgrade');
  const removed = snapshotOf(record, 'S5-uninstalled');
  if (removed.installFolderExists !== false)
    blockers.push('the install folder is still there after the uninstall');
  if (removed.dataFolderExists !== true) blockers.push('the uninstall removed the app data folder');
  if (removed.pathEntries !== 0) {
    blockers.push('a JOY Media entry is still on the user PATH after the uninstall');
  }
  return blockers;
}
