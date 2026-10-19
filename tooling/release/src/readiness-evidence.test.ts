import { describe, expect, it } from 'vitest';
import {
  type ReadinessEvidence,
  REQUIRED_SCENARIOS,
  validateReadinessEvidence,
} from './readiness-evidence.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SHA = 'a'.repeat(40);
const VALID_SHA256 = 'c'.repeat(64);

function validEvidence(overrides?: Partial<ReadinessEvidence>): ReadinessEvidence {
  const scenarioResults = REQUIRED_SCENARIOS.map((id) => ({
    id,
    status: 'passed' as const,
    retries: 0,
    firstAttemptPassed: true,
  }));

  return {
    schemaVersion: 1,
    candidateSha: VALID_SHA,
    lockfileSha256: VALID_SHA256,
    toolchainVersions: { node: '22.0.0', pnpm: '11.15.0' },
    fixtureManifestSha256: VALID_SHA256,
    startUtc: '2026-10-17T00:00:00Z',
    endUtc: '2026-10-17T01:00:00Z',
    commands: [{ name: 'typecheck', exitCode: 0 }],
    passCount: scenarioResults.length,
    failCount: 0,
    skipCount: 0,
    retryCount: 0,
    scenarioResults,
    installerArtifacts: [
      {
        path: 'dist/joy-media-setup.exe',
        expectedSha256: VALID_SHA256,
        observedSha256: VALID_SHA256,
      },
    ],
    redactedPaths: ['dist/joy-media-setup.exe'],
    redactedHashes: { 'dist/joy-media-setup.exe': VALID_SHA256 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReadinessEvidence validation', () => {
  // ---- Original 6 tests (must remain) -------------------------------------

  it('rejectsDifferentCandidate', () => {
    const evidence = validEvidence({ candidateSha: 'd'.repeat(40) });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /candidate/i.test(b));
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejectsMissingRequiredScenario', () => {
    const evidence = validEvidence({
      scenarioResults: [
        {
          id: 'cli.render.playable',
          status: 'passed' as const,
          retries: 0,
          firstAttemptPassed: true,
        },
      ],
      passCount: 1,
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find(
      (b) => /missing.*scenario/i.test(b) || /scenario.*missing/i.test(b),
    );
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejectsRequiredSkip', () => {
    const evidence = validEvidence({
      scenarioResults: [
        ...REQUIRED_SCENARIOS.slice(0, 4).map((id) => ({
          id,
          status: 'passed' as const,
          retries: 0,
          firstAttemptPassed: true,
        })),
        {
          id: REQUIRED_SCENARIOS[4],
          status: 'skipped' as const,
          retries: 0,
          firstAttemptPassed: false,
        },
        ...REQUIRED_SCENARIOS.slice(5).map((id) => ({
          id,
          status: 'passed' as const,
          retries: 0,
          firstAttemptPassed: true,
        })),
      ],
      skipCount: 1,
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find(
      (b) => /skip/i.test(b) && new RegExp(REQUIRED_SCENARIOS[4]).test(b),
    );
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejectsRetryOnlySuccess', () => {
    const evidence = validEvidence({
      scenarioResults: [
        ...REQUIRED_SCENARIOS.slice(0, 3).map((id) => ({
          id,
          status: 'passed' as const,
          retries: 0,
          firstAttemptPassed: true,
        })),
        {
          id: REQUIRED_SCENARIOS[3],
          status: 'passed' as const,
          retries: 2,
          firstAttemptPassed: false,
        },
        ...REQUIRED_SCENARIOS.slice(4).map((id) => ({
          id,
          status: 'passed' as const,
          retries: 0,
          firstAttemptPassed: true,
        })),
      ],
      retryCount: 2,
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find(
      (b) => /retr/i.test(b) && new RegExp(REQUIRED_SCENARIOS[3]).test(b),
    );
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejectsInstallerHashMismatch', () => {
    const evidence = validEvidence({
      installerArtifacts: [
        {
          path: 'dist/joy-media-setup.exe',
          expectedSha256: VALID_SHA256,
          observedSha256: 'd'.repeat(64),
        },
      ],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /hash.*mismatch/i.test(b) || /sha.*mismatch/i.test(b));
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('requires source-bound evidence for installer artifacts produced on another runner', () => {
    const evidence = validEvidence({
      installerArtifacts: [
        {
          path: 'remote/windows/joy-media-setup.exe',
          expectedSha256: VALID_SHA256,
          observedSha256: VALID_SHA256,
        },
      ],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.join(' ')).toMatch(/source evidence/i);
  });

  it('accepts a remote installer hash only when it names a local provenance record', () => {
    const sourcePath = 'test-output/readiness/windows-pass-1.json';
    const evidence = validEvidence({
      installerArtifacts: [
        {
          path: 'remote/windows/joy-media-setup.exe',
          expectedSha256: VALID_SHA256,
          observedSha256: VALID_SHA256,
          sourceEvidencePath: sourcePath,
          sourceEvidenceKey: 'desktopLifecycle.artifacts.candidateSetupSha256',
        },
      ],
      redactedPaths: ['dist/joy-media-setup.exe', sourcePath],
      redactedHashes: {
        'dist/joy-media-setup.exe': VALID_SHA256,
        [sourcePath]: VALID_SHA256,
      },
    });
    expect(validateReadinessEvidence(evidence, VALID_SHA)).toEqual([]);
  });

  it('rejects unsafe or unredacted remote installer provenance paths', () => {
    const sourcePath = 'test-output/readiness/windows-pass-1.json';
    const evidence = validEvidence({
      installerArtifacts: [
        {
          path: 'remote/windows/joy-media-setup.exe',
          expectedSha256: VALID_SHA256,
          observedSha256: VALID_SHA256,
          sourceEvidencePath: sourcePath,
          sourceEvidenceKey: '../candidateSetupSha256',
        },
      ],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.join(' ')).toMatch(/source evidence|redacted/i);
  });

  it('passing complete version-1 record returns empty blockers', () => {
    const evidence = validEvidence();
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers).toEqual([]);
  });

  // ---- New review-required tests ------------------------------------------

  it('rejects reversed timestamps where end < start', () => {
    const evidence = validEvidence({
      startUtc: '2026-10-17T01:00:00Z',
      endUtc: '2026-10-17T00:00:00Z',
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find(
      (b) => /end.*before.*start/i.test(b) || /start.*after.*end/i.test(b),
    );
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects non-UTC timestamps (missing Z)', () => {
    const evidence = validEvidence({
      startUtc: '2026-10-17T00:00:00',
      endUtc: '2026-10-17T01:00:00Z',
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find(
      (b) => /utc/i.test(b) || /must end with Z/i.test(b) || /timestamp.*Z/i.test(b),
    );
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects non-UTC timestamps (offset form)', () => {
    const evidence = validEvidence({
      startUtc: '2026-10-17T00:00:00+05:30',
      endUtc: '2026-10-17T06:30:00Z',
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find(
      (b) => /utc/i.test(b) || /must end with Z/i.test(b) || /timestamp.*Z/i.test(b),
    );
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects command failure (nonzero exit code)', () => {
    const evidence = validEvidence({
      commands: [
        { name: 'typecheck', exitCode: 0 },
        { name: 'lint', exitCode: 1 },
      ],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find(
      (b) =>
        /command.*fail/i.test(b) ||
        /exit.?code.*non.?zero/i.test(b) ||
        /non.?zero.*exit.?code/i.test(b),
    );
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects inconsistent counts (passCount does not match scenario results)', () => {
    const evidence = validEvidence({ passCount: 999 });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find(
      (b) => /count.*inconsistent/i.test(b) || /pass.*count/i.test(b) || /passCount/i.test(b),
    );
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects inconsistent counts (failCount does not match scenario results)', () => {
    const evidence = validEvidence({ failCount: 1 });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find(
      (b) => /count.*inconsistent/i.test(b) || /fail.*count/i.test(b) || /failCount/i.test(b),
    );
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects duplicate scenario IDs', () => {
    const evidence = validEvidence({
      scenarioResults: [
        ...REQUIRED_SCENARIOS.map((id) => ({
          id,
          status: 'passed' as const,
          retries: 0,
          firstAttemptPassed: true,
        })),
        {
          id: REQUIRED_SCENARIOS[0],
          status: 'passed' as const,
          retries: 0,
          firstAttemptPassed: true,
        },
      ],
      passCount: REQUIRED_SCENARIOS.length + 1,
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /duplicate/i.test(b));
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects malformed scenario status', () => {
    const evidence = validEvidence({
      scenarioResults: [
        ...REQUIRED_SCENARIOS.slice(0, 4).map((id) => ({
          id,
          status: 'passed' as const,
          retries: 0,
          firstAttemptPassed: true,
        })),
        {
          id: REQUIRED_SCENARIOS[4],
          status: 'unknown-status' as 'passed' | 'failed' | 'skipped',
          retries: 0,
          firstAttemptPassed: true,
        },
        ...REQUIRED_SCENARIOS.slice(5).map((id) => ({
          id,
          status: 'passed' as const,
          retries: 0,
          firstAttemptPassed: true,
        })),
      ],
      passCount: REQUIRED_SCENARIOS.length - 1,
      skipCount: 0,
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find(
      (b) => /unknown/i.test(b) || /malformed/i.test(b) || /status/i.test(b),
    );
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects Windows absolute path (drive letter with backslash)', () => {
    const hostPath = 'C:\\Program Files\\joy-media\\setup.exe';
    const evidence = validEvidence({
      installerArtifacts: [
        {
          path: hostPath,
          expectedSha256: VALID_SHA256,
          observedSha256: VALID_SHA256,
        },
      ],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /path/i.test(b));
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
    expect(blockers.join(' ')).not.toContain(hostPath);
  });

  it('rejects Windows absolute path (drive letter with forward slash)', () => {
    const evidence = validEvidence({
      redactedPaths: ['D:/projects/joy-media/dist/setup.exe'],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /path/i.test(b));
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects POSIX absolute path', () => {
    const evidence = validEvidence({
      redactedPaths: ['/home/user/joy-media/dist/setup.exe'],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /path/i.test(b));
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects traversal path (..)', () => {
    const evidence = validEvidence({
      redactedPaths: ['dist/../../etc/passwd'],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /path/i.test(b));
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects UNC path', () => {
    const evidence = validEvidence({
      redactedPaths: ['\\\\server\\share\\setup.exe'],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /path/i.test(b));
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects drive-relative path (starts with backslash)', () => {
    const evidence = validEvidence({
      redactedPaths: ['\\dist\\setup.exe'],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /path/i.test(b));
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects backslash-separated path', () => {
    const evidence = validEvidence({
      redactedPaths: ['dist\\sub\\setup.exe'],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /path/i.test(b));
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects missing installer evidence', () => {
    const evidence = validEvidence({ installerArtifacts: [] });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /installer/i.test(b) || /artifact/i.test(b));
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects malformed record (null candidateSha)', () => {
    const evidence = validEvidence({ candidateSha: '' });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /candidate/i.test(b) || /malformed/i.test(b));
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects negative counters', () => {
    const evidence = validEvidence({ passCount: -1 });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /negative/i.test(b) || /count/i.test(b));
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects non-integer counter', () => {
    const evidence = validEvidence({ passCount: 1.5 });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /integer/i.test(b) || /count/i.test(b));
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects empty toolchain version', () => {
    const evidence = validEvidence({
      toolchainVersions: { node: '', pnpm: '11.15.0' },
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find(
      (b) => /toolchain/i.test(b) || /empty/i.test(b) || /version/i.test(b),
    );
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects malformed command row (empty name)', () => {
    const evidence = validEvidence({
      commands: [{ name: '', exitCode: 0 }],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /command/i.test(b));
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects malformed expectedCandidateSha', () => {
    const evidence = validEvidence();
    const blockers = validateReadinessEvidence(evidence, 'not-a-valid-sha');
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /expected.*sha/i.test(b) || /candidate.*sha/i.test(b));
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  it('rejects hash key path with backslash', () => {
    const evidence = validEvidence({
      redactedHashes: { 'dist\\sub\\setup.exe': VALID_SHA256 },
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /path/i.test(b));
    expect(match).toBeDefined();
    expect(match!).not.toHaveLength(0);
  });

  // ---- Fail-closed runtime validation tests --------------------------------

  it('returns blockers for null top-level evidence (no throw)', () => {
    const blockers = validateReadinessEvidence(null as unknown as ReadinessEvidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
  });

  it('returns blockers for non-object top-level evidence (no throw)', () => {
    const blockers = validateReadinessEvidence(
      'not-an-object' as unknown as ReadinessEvidence,
      VALID_SHA,
    );
    expect(blockers.length).toBeGreaterThan(0);
  });

  it('returns blockers for number top-level evidence (no throw)', () => {
    const blockers = validateReadinessEvidence(42 as unknown as ReadinessEvidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
  });

  it('returns blockers for null toolchain map', () => {
    const evidence = validEvidence({
      toolchainVersions: null as unknown as Record<string, string>,
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /toolchain/i.test(b));
    expect(match).toBeDefined();
  });

  it('returns blockers for null command row in array', () => {
    const evidence = validEvidence({
      commands: [null as unknown as { name: string; exitCode: number }],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /command/i.test(b));
    expect(match).toBeDefined();
  });

  it('returns blockers for null scenario row in array', () => {
    const evidence = validEvidence({
      scenarioResults: [
        null as unknown as {
          id: string;
          status: string;
          retries: number;
          firstAttemptPassed: boolean;
        },
      ],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /scenario/i.test(b) || /result/i.test(b));
    expect(match).toBeDefined();
  });

  it('returns blockers for null installer artifact row in array', () => {
    const evidence = validEvidence({
      installerArtifacts: [
        null as unknown as { path: string; expectedSha256: string; observedSha256: string },
      ],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /installer/i.test(b) || /artifact/i.test(b));
    expect(match).toBeDefined();
  });

  it('returns blockers for null redacted path entry', () => {
    const evidence = validEvidence({
      redactedPaths: [null as unknown as string],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /path/i.test(b));
    expect(match).toBeDefined();
  });

  it('rejects invalid calendar date 2026-02-30', () => {
    const evidence = validEvidence({
      startUtc: '2026-02-30T00:00:00Z',
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find(
      (b) => /invalid/i.test(b) || /date/i.test(b) || /timestamp/i.test(b),
    );
    expect(match).toBeDefined();
  });

  it('rejects invalid calendar date 2026-13-01', () => {
    const evidence = validEvidence({
      startUtc: '2026-13-01T00:00:00Z',
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find(
      (b) => /invalid/i.test(b) || /date/i.test(b) || /timestamp/i.test(b),
    );
    expect(match).toBeDefined();
  });

  it('rejects invalid calendar date 2026-00-01', () => {
    const evidence = validEvidence({
      startUtc: '2026-00-01T00:00:00Z',
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find(
      (b) => /invalid/i.test(b) || /date/i.test(b) || /timestamp/i.test(b),
    );
    expect(match).toBeDefined();
  });

  it('rejects Windows drive-relative path (C: without separator)', () => {
    const evidence = validEvidence({
      redactedPaths: ['C:artifacts/setup.exe'],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /path/i.test(b));
    expect(match).toBeDefined();
  });

  it('rejects null redactedHashes', () => {
    const evidence = validEvidence({ redactedHashes: null as unknown as Record<string, string> });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /redacted/i.test(b) || /hash/i.test(b));
    expect(match).toBeDefined();
  });

  // ---- Task 1A final review tests ------------------------------------------

  it('rejects empty commands array', () => {
    const evidence = validEvidence({ commands: [] });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /commands/i.test(b) || /empty/i.test(b));
    expect(match).toBeDefined();
  });

  it('rejects redactedHashes as array (wrong shape)', () => {
    const evidence = validEvidence({
      redactedHashes: [] as unknown as Record<string, string>,
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /redacted/i.test(b) || /hash/i.test(b));
    expect(match).toBeDefined();
  });

  it('rejects bare "C:" as a Windows drive-relative path', () => {
    const evidence = validEvidence({
      redactedPaths: ['C:'],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.length).toBeGreaterThan(0);
    const match = blockers.find((b) => /path/i.test(b));
    expect(match).toBeDefined();
  });

  it('requires every redacted path to have a matching hash', () => {
    const evidence = validEvidence({ redactedHashes: {} });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.some((blocker) => /redacted path has no matching hash/i.test(blocker))).toBe(
      true,
    );
  });

  it('requires every redacted hash to have a matching path', () => {
    const evidence = validEvidence({ redactedPaths: [] });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.some((blocker) => /redacted hash has no matching path/i.test(blocker))).toBe(
      true,
    );
  });

  it('rejects duplicate redacted paths', () => {
    const evidence = validEvidence({
      redactedPaths: ['dist/joy-media-setup.exe', 'dist/joy-media-setup.exe'],
    });
    const blockers = validateReadinessEvidence(evidence, VALID_SHA);
    expect(blockers.some((blocker) => /duplicate redacted path/i.test(blocker))).toBe(true);
  });
});
