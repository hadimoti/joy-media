/**
 * Structured receipts for the attended (owner-at-PC) desktop checks.
 *
 * A receipt is accepted only when a scripted run wrote it, it binds to the candidate commit and
 * to the app binary, every required check passed on the first attempt, and the guards show that
 * the joy:// registration and the owner's asset library did not change. Manual runs are never
 * receipts: a run driven by hand is recorded as partial evidence elsewhere.
 */

export const ATTENDED_RECEIPT_SCHEMA = 'joy-media.attended-receipt/1';

/** The attended scenarios that a scripted run can produce. Lifecycle receipts have their own producer. */
export const ATTENDED_SCENARIOS = [
  'desktop.app.restart-save-export',
  'project.persistence.fresh-process',
  'desktop.export-media-semantics',
  'cli.render.windows-entrypoints',
] as const;

export type AttendedScenarioId = (typeof ATTENDED_SCENARIOS)[number];

/** Checks each scenario must report as passed, by name. A missing, failed or not-run check blocks it. */
export const REQUIRED_ATTENDED_CHECKS: Readonly<Record<AttendedScenarioId, readonly string[]>> = {
  'desktop.app.restart-save-export': [
    'project-saved',
    'app-restarted',
    'project-reopened-after-restart',
    'export-completed',
    'export-probed-playable',
  ],
  'project.persistence.fresh-process': [
    'editable-project-exported',
    'fresh-profile-started',
    'project-imported-in-fresh-profile',
    'export-from-fresh-profile-probed',
  ],
  'desktop.export-media-semantics': [
    'export-completed',
    'stream-layout-matches-preset',
    'duration-matches-timeline',
    'frame-count-matches-timeline',
    'audio-present',
    'picture-matches-reference',
    'dissolve-checked',
  ],
  'cli.render.windows-entrypoints': [
    'joy-cmd-version-reported',
    'joy-media-cmd-version-reported',
    'render-entrypoint-wrote-manifest',
  ],
};

/** SHA-256 of the joy:// registration key as exported with `reg export` on the owner's PC. */
export const JOY_KEY_EXPECTED_SHA256 =
  'af05be55222c86fece27e738b7e8a931cb4261c9797261c67dde3c71a4e5cac0';

export interface AttendedCheck {
  readonly name: string;
  readonly status: 'passed' | 'failed' | 'not-run';
  readonly detail: string;
}

export interface AttendedArtifact {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface AttendedReceipt {
  readonly schema: typeof ATTENDED_RECEIPT_SCHEMA;
  readonly scenario: {
    readonly id: AttendedScenarioId;
    readonly status: 'passed' | 'failed';
    readonly firstAttemptPassed: boolean;
    readonly retries: number;
  };
  readonly candidateSha: string;
  readonly app: { readonly exeSha256: string; readonly unpackedDir: string };
  readonly run: {
    readonly id: string;
    readonly attempt: number;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly operator: 'owner-at-pc';
    readonly mode: 'scripted';
    readonly manual: false;
  };
  readonly guards: {
    readonly joyKeyBefore: string;
    readonly joyKeyAfter: string;
    readonly ownerLibraryFilesBefore: number;
    readonly ownerLibraryFilesAfter: number;
    readonly installedFolderTouched: false;
  };
  readonly checks: readonly AttendedCheck[];
  readonly artifacts: readonly AttendedArtifact[];
}

export interface AttendedExpectation {
  readonly scenarioId: AttendedScenarioId;
  readonly candidateSha: string;
}

const HEX40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

/**
 * Returns the reasons a receipt must be refused. An empty list means the receipt is accepted for
 * the given scenario and candidate. Validation is fail-closed: anything unexpected is a blocker.
 */
export function validateAttendedReceipt(value: unknown, expected: AttendedExpectation): string[] {
  const blockers: string[] = [];
  const receipt = asRecord(value);
  if (receipt === undefined) return ['receipt is not a JSON object'];

  if (receipt.schema !== ATTENDED_RECEIPT_SCHEMA) {
    blockers.push(`schema must be ${ATTENDED_RECEIPT_SCHEMA}`);
  }

  const scenario = asRecord(receipt.scenario);
  if (scenario === undefined) {
    blockers.push('scenario is missing');
  } else {
    if (scenario.id !== expected.scenarioId)
      blockers.push(`scenario id must be ${expected.scenarioId}`);
    if (scenario.status !== 'passed') blockers.push('scenario status must be passed');
    if (scenario.firstAttemptPassed !== true)
      blockers.push('scenario must pass on its first attempt');
    if (scenario.retries !== 0) blockers.push('scenario retries must be 0');
  }

  if (typeof receipt.candidateSha !== 'string' || !HEX40.test(receipt.candidateSha)) {
    blockers.push('candidateSha must be a full lowercase commit SHA');
  } else if (receipt.candidateSha !== expected.candidateSha) {
    blockers.push('candidateSha does not match the candidate under test');
  }

  const app = asRecord(receipt.app);
  if (app === undefined) {
    blockers.push('app is missing');
  } else {
    if (typeof app.exeSha256 !== 'string' || !HEX64.test(app.exeSha256)) {
      blockers.push('app.exeSha256 must be a SHA-256 digest');
    }
    if (typeof app.unpackedDir !== 'string' || app.unpackedDir.trim() === '') {
      blockers.push('app.unpackedDir is missing');
    }
  }

  const run = asRecord(receipt.run);
  if (run === undefined) {
    blockers.push('run is missing');
  } else {
    if (typeof run.id !== 'string' || run.id.trim() === '') blockers.push('run.id is missing');
    if (!Number.isInteger(run.attempt) || (run.attempt as number) < 1) {
      blockers.push('run.attempt must be a positive integer');
    }
    const started = Date.parse(String(run.startedAt));
    const finished = Date.parse(String(run.finishedAt));
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
      blockers.push('run times are missing or out of order');
    }
    if (run.operator !== 'owner-at-pc') blockers.push('run.operator must be owner-at-pc');
    if (run.mode !== 'scripted')
      blockers.push('run.mode must be scripted; manual runs are not receipts');
    if (run.manual !== false) blockers.push('run.manual must be false');
  }

  const guards = asRecord(receipt.guards);
  if (guards === undefined) {
    blockers.push('guards are missing');
  } else {
    if (guards.joyKeyBefore !== JOY_KEY_EXPECTED_SHA256) {
      blockers.push('joy:// key was not the expected value before the run');
    }
    if (guards.joyKeyAfter !== JOY_KEY_EXPECTED_SHA256) {
      blockers.push('joy:// key was not the expected value after the run');
    }
    if (
      !isCount(guards.ownerLibraryFilesBefore) ||
      guards.ownerLibraryFilesBefore !== guards.ownerLibraryFilesAfter
    ) {
      blockers.push('the owner asset library changed during the run');
    }
    if (guards.installedFolderTouched !== false) {
      blockers.push('the installed JOY Media folder was touched');
    }
  }

  if (!Array.isArray(receipt.checks)) {
    blockers.push('checks are missing');
  } else {
    const seen = new Map<string, number>();
    for (const entry of receipt.checks) {
      const check = asRecord(entry);
      if (check === undefined || typeof check.name !== 'string') {
        blockers.push('a check has no name');
        continue;
      }
      seen.set(check.name, (seen.get(check.name) ?? 0) + 1);
      if (check.status !== 'passed')
        blockers.push(`check ${check.name} is ${String(check.status)}`);
    }
    for (const name of REQUIRED_ATTENDED_CHECKS[expected.scenarioId]) {
      const count = seen.get(name) ?? 0;
      if (count === 0) blockers.push(`required check ${name} is missing`);
      if (count > 1) blockers.push(`required check ${name} is reported more than once`);
    }
  }

  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length === 0) {
    blockers.push('artifacts are missing');
  } else {
    for (const entry of receipt.artifacts) {
      const artifact = asRecord(entry);
      if (artifact === undefined || typeof artifact.name !== 'string' || artifact.name === '') {
        blockers.push('an artifact has no name');
        continue;
      }
      if (typeof artifact.path !== 'string' || artifact.path.trim() === '') {
        blockers.push(`artifact ${artifact.name} has no path`);
      }
      if (typeof artifact.sha256 !== 'string' || !HEX64.test(artifact.sha256)) {
        blockers.push(`artifact ${artifact.name} must have a SHA-256 digest`);
      }
      if (!Number.isInteger(artifact.bytes) || (artifact.bytes as number) <= 0) {
        blockers.push(`artifact ${artifact.name} must have a positive byte count`);
      }
    }
  }

  return blockers;
}

/** Throws with every blocker listed when the receipt is refused. */
export function assertAttendedReceipt(value: unknown, expected: AttendedExpectation): void {
  const blockers = validateAttendedReceipt(value, expected);
  if (blockers.length > 0) {
    throw new Error(`attended receipt refused: ${blockers.join('; ')}`);
  }
}
