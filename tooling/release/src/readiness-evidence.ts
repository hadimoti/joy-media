// ---------------------------------------------------------------------------
// Readiness-evidence validator contract
//
// This module defines the ReadinessEvidence record and a deterministic
// validateReadinessEvidence() function that returns a list of blocking
// reasons. A valid complete record returns [].
//
// SCENARIO INVENTORY — source of truth for required readiness scenarios.
// Additions or removals MUST be paired with:
//   - docs/qa/READINESS-MATRIX.md
//   - A deliberate gate update
// ---------------------------------------------------------------------------

/**
 * The required scenario IDs that every readiness evidence record must satisfy.
 * Each scenario must exist in `scenarioResults`, have passed on its first
 * attempt, and have zero retries.
 */
export const REQUIRED_SCENARIOS: readonly string[] = [
  'cli.render.playable',
  'cli.render.unsupported-features',
  'cli.render.failure-recovery',
  'cli.render.windows-entrypoints',
  'project.persistence.fresh-process',
  'desktop.app.restart-save-export',
  'desktop.windows.installed-lifecycle',
  'release.exact-candidate-two-pass',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScenarioResult {
  /** Scenario identifier, e.g. "cli.render.playable". */
  readonly id: string;
  /** Outcome of the scenario run. Only "passed", "failed", or "skipped". */
  readonly status: 'passed' | 'failed' | 'skipped';
  /** Number of retries attempted. */
  readonly retries: number;
  /** Whether the first attempt of this scenario passed. */
  readonly firstAttemptPassed: boolean;
}

export interface InstallerArtifact {
  /**
   * Repository-relative path (forward slashes). Must NOT be an absolute host
   * path or contain path-traversal segments ("..").
   */
  readonly path: string;
  /** Expected SHA-256 hex digest (lowercase, 64 chars). */
  readonly expectedSha256: string;
  /** Observed SHA-256 hex digest (lowercase, 64 chars). */
  readonly observedSha256: string;
}

export interface ReadinessEvidence {
  /** Schema version. Must be 1 for this validator. */
  readonly schemaVersion: 1;
  /** Full commit SHA of the candidate under test. */
  readonly candidateSha: string;
  /** SHA-256 of the lockfile at evidence time. */
  readonly lockfileSha256: string;
  /** Map of tool name to version string. */
  readonly toolchainVersions: Readonly<Record<string, string>>;
  /** SHA-256 of the fixture manifest. */
  readonly fixtureManifestSha256: string;
  /** ISO-8601 UTC start timestamp (must end with Z). */
  readonly startUtc: string;
  /** ISO-8601 UTC end timestamp (must end with Z). */
  readonly endUtc: string;
  /** Named commands and their exit codes. */
  readonly commands: readonly { readonly name: string; readonly exitCode: number }[];
  /** Total number of passed scenarios. */
  readonly passCount: number;
  /** Total number of failed scenarios. */
  readonly failCount: number;
  /** Total number of skipped scenarios. */
  readonly skipCount: number;
  /** Total number of retries across all scenarios. */
  readonly retryCount: number;
  /** Results for each scenario that was run. */
  readonly scenarioResults: readonly ScenarioResult[];
  /** Installer artifact records with expected and observed hashes. */
  readonly installerArtifacts: readonly InstallerArtifact[];
  /** Redacted repository-relative artifact paths. */
  readonly redactedPaths: readonly string[];
  /** Redacted artifact hashes keyed by repository-relative path. */
  readonly redactedHashes: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
/** Strict ISO-8601 UTC timestamp ending in Z (e.g. "2026-10-17T00:00:00Z"). */
const UTC_TIMESTAMP_FORMAT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u;
const VALID_STATUS = /^(?:passed|failed|skipped)$/u;

/** Days in each month for non-leap and leap years. Index 1-based. */
const DAYS_IN_MONTH: readonly number[] = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month] ?? 0;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Check that a path is a repository-relative path:
 * - Uses forward slashes only (no backslashes)
 * - Does not start with "/" or a Windows drive letter (absolute)
 * - Does not start with "\\" (UNC)
 * - Does not contain ".." segments (traversal)
 * - Does not start with "\" (drive-relative)
 * - Does not match drive-letter prefix without separator (e.g. "C:artifacts/")
 * - Is not empty
 */
function isRepoRelativePath(path: string): boolean {
  if (typeof path !== 'string') return false;
  if (path.length === 0) return false;
  // Reject absolute Unix paths
  if (path.startsWith('/')) return false;
  // Reject UNC paths
  if (path.startsWith('\\\\')) return false;
  // Reject absolute Windows paths (drive letters with / or \)
  if (/^[A-Za-z]:[/\\]/u.test(path)) return false;
  // Reject drive-relative paths (starts with \)
  if (path.startsWith('\\')) return false;
  // Reject bare drive letter (e.g. "C:")
  if (/^[A-Za-z]:$/u.test(path)) return false;
  // Reject drive-relative without separator (e.g. "C:artifacts")
  if (/^[A-Za-z]:[^/\\]/u.test(path)) return false;
  // Reject backslash-separated paths
  if (path.includes('\\')) return false;
  // Reject traversal segments
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '..') return false;
  }
  return true;
}

function isNonNegativeInteger(value: number): boolean {
  return (
    typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

function pathLabel(path: unknown): string {
  return isRepoRelativePath(path) ? path : '<redacted invalid path>';
}

/**
 * Strictly validate a UTC timestamp string. Returns the parsed Date if valid,
 * or null if the format, calendar date, or time components are invalid.
 *
 * Unlike Date.parse(), this rejects invalid calendar dates such as 2026-02-30
 * that JavaScript silently normalises to March 2.
 */
function parseStrictUtcTimestamp(value: string): Date | null {
  const m = UTC_TIMESTAMP_FORMAT.exec(value);
  if (m === null) return null;

  const year = Number.parseInt(m[1], 10);
  const month = Number.parseInt(m[2], 10);
  const day = Number.parseInt(m[3], 10);
  const hour = Number.parseInt(m[4], 10);
  const minute = Number.parseInt(m[5], 10);
  const second = Number.parseInt(m[6], 10);

  // Validate month
  if (month < 1 || month > 12) return null;
  // Validate day
  if (day < 1 || day > daysInMonth(year, month)) return null;
  // Validate time components
  if (hour > 23 || minute > 59 || second > 59) return null;

  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a ReadinessEvidence record against an expected candidate SHA.
 *
 * Returns a list of blocking reasons (human-readable strings). An empty array
 * means the evidence is valid and passes all checks.
 *
 * Validation is deterministic and fail-closed: malformed or missing evidence
 * produces one or more blocking reasons. This function never throws — even
 * null, non-object, or malformed input returns blockers.
 */
export function validateReadinessEvidence(
  evidence: ReadinessEvidence,
  expectedCandidateSha: string,
): string[] {
  const blockers: string[] = [];

  // -- Top-level type guard -------------------------------------------------
  if (evidence === null || typeof evidence !== 'object') {
    blockers.push('evidence must be a non-null object');
    return blockers;
  }

  // -- Schema version -------------------------------------------------------
  if (evidence.schemaVersion !== 1) {
    blockers.push(`unsupported schema version: ${String(evidence.schemaVersion)}; expected 1`);
  }

  // -- Expected candidate SHA validation ------------------------------------
  if (!COMMIT_SHA.test(expectedCandidateSha)) {
    blockers.push(`malformed expected candidate SHA: ${expectedCandidateSha}`);
  }

  // -- Candidate SHA --------------------------------------------------------
  if (typeof evidence.candidateSha !== 'string' || evidence.candidateSha !== expectedCandidateSha) {
    blockers.push(
      `candidate SHA mismatch: got ${String(evidence.candidateSha)}, expected ${expectedCandidateSha}`,
    );
  }

  if (!COMMIT_SHA.test(evidence.candidateSha)) {
    blockers.push(`malformed candidate SHA: ${String(evidence.candidateSha)}`);
  }

  // -- Lockfile SHA-256 -----------------------------------------------------
  if (typeof evidence.lockfileSha256 !== 'string' || !SHA256_HEX.test(evidence.lockfileSha256)) {
    blockers.push(`malformed lockfile SHA-256: ${String(evidence.lockfileSha256)}`);
  }

  // -- Fixture manifest SHA-256 ---------------------------------------------
  if (
    typeof evidence.fixtureManifestSha256 !== 'string' ||
    !SHA256_HEX.test(evidence.fixtureManifestSha256)
  ) {
    blockers.push(`malformed fixture manifest SHA-256: ${String(evidence.fixtureManifestSha256)}`);
  }

  // -- Toolchain versions ---------------------------------------------------
  const toolchain = evidence.toolchainVersions;
  if (toolchain === null || typeof toolchain !== 'object' || Array.isArray(toolchain)) {
    blockers.push('toolchain versions must be a non-null object');
  } else {
    if (Object.keys(toolchain).length === 0) {
      blockers.push('toolchain versions are empty');
    }
    for (const [tool, version] of Object.entries(toolchain)) {
      if (typeof version !== 'string' || version.trim() === '') {
        blockers.push(`toolchain version for "${tool}" is empty`);
      }
    }
  }

  // -- Timestamps -----------------------------------------------------------
  const startParsed = parseStrictUtcTimestamp(evidence.startUtc);
  const endParsed = parseStrictUtcTimestamp(evidence.endUtc);

  if (startParsed === null) {
    blockers.push(`start timestamp is not a valid UTC date: ${String(evidence.startUtc)}`);
  }
  if (endParsed === null) {
    blockers.push(`end timestamp is not a valid UTC date: ${String(evidence.endUtc)}`);
  }
  if (startParsed !== null && endParsed !== null && endParsed.getTime() < startParsed.getTime()) {
    blockers.push(
      `end timestamp is before start timestamp: start=${evidence.startUtc}, end=${evidence.endUtc}`,
    );
  }

  // -- Command validation ---------------------------------------------------
  if (!Array.isArray(evidence.commands)) {
    blockers.push('commands must be an array');
  } else if (evidence.commands.length === 0) {
    blockers.push('commands array is empty; at least one command is required');
  } else {
    for (let i = 0; i < evidence.commands.length; i++) {
      const cmd = evidence.commands[i];
      if (cmd === null || typeof cmd !== 'object') {
        blockers.push(`command at index ${i} is not a valid object`);
        continue;
      }
      if (typeof cmd.name !== 'string' || cmd.name.trim() === '') {
        blockers.push(`command at index ${i} has missing or empty name`);
      }
      if (
        typeof cmd.exitCode !== 'number' ||
        !Number.isFinite(cmd.exitCode) ||
        !Number.isInteger(cmd.exitCode)
      ) {
        blockers.push(`command "${cmd.name ?? i}" has invalid exit code: ${String(cmd.exitCode)}`);
      }
      if (cmd.exitCode !== 0) {
        blockers.push(`command "${cmd.name}" failed with non-zero exit code: ${cmd.exitCode}`);
      }
    }
  }

  // -- Counter validation ---------------------------------------------------
  if (!isNonNegativeInteger(evidence.passCount)) {
    blockers.push(`passCount must be a non-negative integer: ${String(evidence.passCount)}`);
  }
  if (!isNonNegativeInteger(evidence.failCount)) {
    blockers.push(`failCount must be a non-negative integer: ${String(evidence.failCount)}`);
  }
  if (!isNonNegativeInteger(evidence.skipCount)) {
    blockers.push(`skipCount must be a non-negative integer: ${String(evidence.skipCount)}`);
  }
  if (!isNonNegativeInteger(evidence.retryCount)) {
    blockers.push(`retryCount must be a non-negative integer: ${String(evidence.retryCount)}`);
  }

  // -- Scenario results validation ------------------------------------------
  if (!Array.isArray(evidence.scenarioResults)) {
    blockers.push('scenarioResults must be an array');
  } else {
    const seenIds = new Set<string>();
    let actualPassed = 0;
    let actualFailed = 0;
    let actualSkipped = 0;
    let actualRetries = 0;

    for (let i = 0; i < evidence.scenarioResults.length; i++) {
      const result = evidence.scenarioResults[i];

      // Null/object guard
      if (result === null || typeof result !== 'object') {
        blockers.push(`scenarioResult at index ${i} is not a valid object`);
        continue;
      }

      // Validate ID
      if (typeof result.id !== 'string' || result.id.trim() === '') {
        blockers.push(`scenarioResult at index ${i} has missing or empty id`);
        continue;
      }

      // Duplicate detection
      if (seenIds.has(result.id)) {
        blockers.push(`duplicate scenario id: ${result.id}`);
      }
      seenIds.add(result.id);

      // Validate status
      if (typeof result.status !== 'string' || !VALID_STATUS.test(result.status)) {
        blockers.push(`scenario "${result.id}" has unknown status: ${String(result.status)}`);
      }

      // Validate retries
      if (!isNonNegativeInteger(result.retries)) {
        blockers.push(
          `scenario "${result.id}" has invalid retries value: ${String(result.retries)}`,
        );
      }

      // Validate firstAttemptPassed
      if (typeof result.firstAttemptPassed !== 'boolean') {
        blockers.push(`scenario "${result.id}" has non-boolean firstAttemptPassed`);
      }

      // Tally actual counts
      if (result.status === 'passed') actualPassed++;
      else if (result.status === 'failed') actualFailed++;
      else if (result.status === 'skipped') actualSkipped++;
      if (isNonNegativeInteger(result.retries)) {
        actualRetries += result.retries;
      }
    }

    // -- Count consistency checks -------------------------------------------
    if (evidence.passCount !== actualPassed) {
      blockers.push(
        `passCount (${evidence.passCount}) does not match actual passed scenarios (${actualPassed})`,
      );
    }
    if (evidence.failCount !== actualFailed) {
      blockers.push(
        `failCount (${evidence.failCount}) does not match actual failed scenarios (${actualFailed})`,
      );
    }
    if (evidence.skipCount !== actualSkipped) {
      blockers.push(
        `skipCount (${evidence.skipCount}) does not match actual skipped scenarios (${actualSkipped})`,
      );
    }
    if (evidence.retryCount !== actualRetries) {
      blockers.push(
        `retryCount (${evidence.retryCount}) does not match actual retries (${actualRetries})`,
      );
    }

    // -- Required scenario inventory ------------------------------------------
    const resultById = new Map(
      evidence.scenarioResults
        .filter((r): r is NonNullable<typeof r> => r !== null && typeof r === 'object')
        .map((r) => [r.id, r] as [string, NonNullable<typeof r>]),
    );

    for (const requiredId of REQUIRED_SCENARIOS) {
      const result = resultById.get(requiredId);
      if (result === undefined) {
        blockers.push(`missing required scenario: ${requiredId}`);
        continue;
      }

      if (result.status === 'skipped') {
        blockers.push(`required scenario skipped: ${requiredId}`);
      } else if (result.status === 'failed') {
        blockers.push(`required scenario failed: ${requiredId}`);
      } else if (result.status !== 'passed') {
        blockers.push(`required scenario has unknown status "${result.status}": ${requiredId}`);
      }

      if (result.firstAttemptPassed !== true) {
        blockers.push(
          `required scenario did not pass on first attempt: ${requiredId} (firstAttemptPassed=${String(result.firstAttemptPassed)})`,
        );
      }

      if (result.retries > 0) {
        blockers.push(
          `required scenario has retries: ${requiredId} (retries=${result.retries}; zero retries required)`,
        );
      }
    }
  }

  // -- Installer artifact checks --------------------------------------------
  if (!Array.isArray(evidence.installerArtifacts)) {
    blockers.push('installerArtifacts must be an array');
  } else if (evidence.installerArtifacts.length === 0) {
    blockers.push('installer artifact evidence is required but none provided');
  } else {
    for (const artifact of evidence.installerArtifacts) {
      if (artifact === null || typeof artifact !== 'object') {
        blockers.push('installer artifact entry is not a valid object');
        continue;
      }
      // Validate path is repo-relative (no absolute host path, no traversal)
      if (!isRepoRelativePath(artifact.path)) {
        blockers.push(
          `installer artifact path is not a valid repository-relative path: ${pathLabel(artifact.path)}`,
        );
      }

      if (!SHA256_HEX.test(artifact.expectedSha256)) {
        blockers.push(
          `installer artifact "${pathLabel(artifact.path)}" has malformed expected SHA-256: ${String(artifact.expectedSha256)}`,
        );
      }

      if (!SHA256_HEX.test(artifact.observedSha256)) {
        blockers.push(
          `installer artifact "${pathLabel(artifact.path)}" has malformed observed SHA-256: ${String(artifact.observedSha256)}`,
        );
      }

      if (
        SHA256_HEX.test(artifact.expectedSha256) &&
        SHA256_HEX.test(artifact.observedSha256) &&
        artifact.expectedSha256 !== artifact.observedSha256
      ) {
        blockers.push(
          `installer artifact hash mismatch for "${pathLabel(artifact.path)}": expected ${artifact.expectedSha256}, observed ${artifact.observedSha256}`,
        );
      }
    }
  }

  // -- Redacted paths -------------------------------------------------------
  const validRedactedPaths = new Set<string>();
  if (!Array.isArray(evidence.redactedPaths)) {
    blockers.push('redactedPaths must be an array');
  } else {
    for (const path of evidence.redactedPaths) {
      if (!isRepoRelativePath(path)) {
        blockers.push(`redacted path is not a valid repository-relative path: ${pathLabel(path)}`);
      } else if (validRedactedPaths.has(path)) {
        blockers.push(`duplicate redacted path: ${pathLabel(path)}`);
      } else {
        validRedactedPaths.add(path);
      }
    }
  }

  // -- Redacted hashes ------------------------------------------------------
  if (
    typeof evidence.redactedHashes !== 'object' ||
    evidence.redactedHashes === null ||
    Array.isArray(evidence.redactedHashes)
  ) {
    blockers.push('redactedHashes must be a non-null object');
  } else {
    const redactedHashPaths = new Set(Object.keys(evidence.redactedHashes));
    for (const [path, hash] of Object.entries(evidence.redactedHashes)) {
      if (!isRepoRelativePath(path)) {
        blockers.push(
          `redacted hash path is not a valid repository-relative path: ${pathLabel(path)}`,
        );
      }
      if (!SHA256_HEX.test(hash)) {
        blockers.push(`redacted hash for "${pathLabel(path)}" is malformed: ${hash}`);
      }
      if (!validRedactedPaths.has(path)) {
        blockers.push(`redacted hash has no matching path: ${pathLabel(path)}`);
      }
    }
    for (const path of validRedactedPaths) {
      if (!redactedHashPaths.has(path)) {
        blockers.push(`redacted path has no matching hash: ${pathLabel(path)}`);
      }
    }
  }

  return blockers;
}
