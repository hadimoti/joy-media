import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ATTENDED_RECEIPT_SCHEMA,
  JOY_KEY_EXPECTED_SHA256,
  REQUIRED_ATTENDED_CHECKS,
} from './attended-receipt.ts';
import type { LOCAL_ONLY_ATTENDED_SCENARIOS } from './gate.ts';
import {
  evaluateReleaseGate,
  readAttendedEvidence,
  type ReleaseAttendedEvidence,
  type ReleaseGateInput,
} from './gate.ts';
import {
  REQUIRED_LIFECYCLE_STEPS,
  requiredUpgradeSteps,
  SANDBOX_LIFECYCLE_SCHEMA,
  SANDBOX_UPGRADE_SCHEMA,
} from './sandbox-lifecycle-receipt.ts';

const CANDIDATE = 'a'.repeat(40);
const SETUP = 'c'.repeat(64);
const CANDIDATE_VERSION = '1.1.1';

function attendedReceipt(scenarioId: keyof typeof LOCAL_ONLY_ATTENDED_SCENARIOS) {
  return {
    schema: ATTENDED_RECEIPT_SCHEMA,
    scenario: { id: scenarioId, status: 'passed', firstAttemptPassed: true, retries: 0 },
    candidateSha: CANDIDATE,
    app: { exeSha256: 'e'.repeat(64), unpackedDir: 'C:\\scratch\\app' },
    run: {
      id: 'run-1',
      attempt: 1,
      startedAt: '2026-11-12T10:00:00.000Z',
      finishedAt: '2026-11-12T10:05:00.000Z',
      operator: 'owner-at-pc',
      mode: 'scripted',
      manual: false,
    },
    guards: {
      joyKeyBefore: JOY_KEY_EXPECTED_SHA256,
      joyKeyAfter: JOY_KEY_EXPECTED_SHA256,
      ownerLibraryFilesBefore: 3221,
      ownerLibraryFilesAfter: 3221,
      installedFolderTouched: false,
    },
    checks: REQUIRED_ATTENDED_CHECKS[scenarioId].map((name) => ({
      name,
      status: 'passed',
      detail: 'ok',
    })),
    artifacts: [{ name: 'export.mp4', path: 'export.mp4', sha256: 'f'.repeat(64), bytes: 10 }],
  };
}

function lifecycleReceipt() {
  return {
    schema: SANDBOX_LIFECYCLE_SCHEMA,
    startedAt: '2026-11-12T10:00:00.000Z',
    finishedAt: '2026-11-12T10:01:00.000Z',
    identity: { user: 'WDAGUtilityAccount' },
    steps: REQUIRED_LIFECYCLE_STEPS.map((id) => ({
      id,
      result: 'pass',
      detail: id === 'setup-digest' ? SETUP : 'ok',
    })),
    beforeInstall: { installFolderExists: false },
    afterInstall: { installFolderExists: true, installFileCount: 10, uninstallKey: true },
    afterUninstall: {
      installFolderExists: false,
      uninstallKey: false,
      pathHasJoy: false,
      joyKey: null,
      desktopShortcut: false,
      startMenuShortcut: false,
    },
  };
}

/** A fake upgrade receipt from `from` to the candidate version. */
function upgradeReceipt(from: '1.0.2' | '1.1.0') {
  const fromTag = from === '1.0.2' ? 'v102' : 'v110';
  const toTag = 'v111';
  return {
    schema: SANDBOX_UPGRADE_SCHEMA,
    startedAt: '2026-11-12T10:00:00.000Z',
    finishedAt: '2026-11-12T10:02:00.000Z',
    identity: { user: 'WDAGUtilityAccount' },
    fromVersion: from,
    fromMode: from === '1.0.2' ? 'zip' : 'setup',
    steps: requiredUpgradeSteps(from, CANDIDATE_VERSION, from === '1.0.2' ? 'zip' : 'setup').map(
      (id) => ({
        id,
        result: 'pass',
        detail: id === 'new-setup-digest' ? SETUP : 'ok',
      }),
    ),
    [`S1-${fromTag}-installed`]: { appPackageVersion: from },
    'S3-upgraded': {
      appPackageVersion: CANDIDATE_VERSION,
      uninstallDisplayVersion: CANDIDATE_VERSION,
    },
    [`S4-${toTag}-after-run`]: { dataFolderExists: true },
    'S5-uninstalled': {
      installFolderExists: false,
      dataFolderExists: true,
      pathEntries: 0,
      joyKey: null,
    },
  };
}

function evidence(overrides: Partial<ReleaseAttendedEvidence> = {}): ReleaseAttendedEvidence {
  return {
    candidateSha: CANDIDATE,
    setupSha256: SETUP,
    receipts: {
      'desktop.app.restart-save-export': attendedReceipt('desktop.app.restart-save-export'),
      'project.persistence.fresh-process': attendedReceipt('project.persistence.fresh-process'),
    },
    sandboxLifecycle: lifecycleReceipt(),
    sandboxUpgrade: upgradeReceipt('1.0.2'),
    sandboxUpgradeFrom110: upgradeReceipt('1.1.0'),
    candidateVersion: CANDIDATE_VERSION,
    ...overrides,
  };
}

function input(overrides: Partial<ReleaseGateInput> = {}): ReleaseGateInput {
  return {
    testSummary: { collected: 10, failed: 0 },
    dirtyGeneratedArtifacts: [],
    fixtureHandlers: [],
    deploymentManifests: [],
    builds: { editor: true, worker: true },
    staticAssetPackaging: [],
    manifestGenerated: true,
    sbomGenerated: true,
    browserJourneys: [],
    featureStatus: { auditedOn: new Date().toISOString().slice(0, 10), statuses: ['production'] },
    ...overrides,
  };
}

const NOW = new Date();
const status = (overrides: Partial<ReleaseGateInput>, id: string): string | undefined =>
  evaluateReleaseGate(input(overrides), NOW).checks.find((item) => item.id === id)?.status;
const ids = (overrides: Partial<ReleaseGateInput>): string[] =>
  evaluateReleaseGate(input(overrides), NOW).checks.map((item) => item.id);

describe('local-only gate profile', () => {
  it('keeps the standard checks and leaves out the two the local build cannot have', () => {
    const standard = ids({});
    expect(standard).toContain('browser-journey');
    expect(standard).toContain('operational-evidence');
    const local = ids({ profile: 'local-only', attendedEvidence: evidence() });
    expect(local).not.toContain('browser-journey');
    expect(local).not.toContain('operational-evidence');
    expect(local).toContain('attended-journey');
    expect(local).toContain('lifecycle-evidence');
    expect(local).toHaveLength(standard.length);
  });

  it('passes the two replacement checks on complete receipts for the candidate', () => {
    const overrides = { profile: 'local-only', attendedEvidence: evidence() } as const;
    expect(status(overrides, 'attended-journey')).toBe('passed');
    expect(status(overrides, 'lifecycle-evidence')).toBe('passed');
  });

  it('fails both when no receipts exist, and they can not be waived', () => {
    const none = { profile: 'local-only', attendedEvidence: null } as const;
    expect(status(none, 'attended-journey')).toBe('failed');
    expect(status(none, 'lifecycle-evidence')).toBe('failed');
    const waived = evaluateReleaseGate(
      input({
        ...none,
        waivers: [
          {
            checkId: 'lifecycle-evidence',
            owner: 'owner',
            reason: 'try',
            expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
          },
        ],
      }),
      NOW,
    );
    expect(waived.checks.find((item) => item.id === 'lifecycle-evidence')?.status).toBe('failed');
  });

  it('fails the journey when a receipt is missing, for another commit, or failed', () => {
    const missing = evidence({
      receipts: {
        'desktop.app.restart-save-export': attendedReceipt('desktop.app.restart-save-export'),
      },
    });
    expect(status({ profile: 'local-only', attendedEvidence: missing }, 'attended-journey')).toBe(
      'failed',
    );
    const other = evidence({ candidateSha: 'b'.repeat(40) });
    expect(status({ profile: 'local-only', attendedEvidence: other }, 'attended-journey')).toBe(
      'failed',
    );
    const failed = attendedReceipt('project.persistence.fresh-process');
    failed.scenario.status = 'failed';
    const broken = evidence({
      receipts: {
        'desktop.app.restart-save-export': attendedReceipt('desktop.app.restart-save-export'),
        'project.persistence.fresh-process': failed,
      },
    });
    expect(status({ profile: 'local-only', attendedEvidence: broken }, 'attended-journey')).toBe(
      'failed',
    );
  });

  it('fails the lifecycle check for a setup that is not the candidate setup, or a missing upgrade', () => {
    const wrongSetup = evidence({ setupSha256: 'd'.repeat(64) });
    expect(
      status({ profile: 'local-only', attendedEvidence: wrongSetup }, 'lifecycle-evidence'),
    ).toBe('failed');
    const noUpgrade = evidence({ sandboxUpgrade: undefined });
    expect(
      status({ profile: 'local-only', attendedEvidence: noUpgrade }, 'lifecycle-evidence'),
    ).toBe('failed');
  });

  it('fails the lifecycle check when the upgrade from v1.1.0 is missing or ends on another version', () => {
    const noFrom110 = evidence({ sandboxUpgradeFrom110: undefined });
    expect(
      status({ profile: 'local-only', attendedEvidence: noFrom110 }, 'lifecycle-evidence'),
    ).toBe('failed');
    const noCandidateVersion = evidence({ candidateVersion: undefined });
    expect(
      status({ profile: 'local-only', attendedEvidence: noCandidateVersion }, 'lifecycle-evidence'),
    ).toBe('failed');
    // A v1.0.2 receipt filed as the v1.1.0 receipt is refused: the receipt names its start version.
    const swapped = evidence({
      sandboxUpgradeFrom110: upgradeReceipt('1.0.2'),
    });
    expect(status({ profile: 'local-only', attendedEvidence: swapped }, 'lifecycle-evidence')).toBe(
      'failed',
    );
  });

  it('judges the source as a clean tree and marks the hosted performance check not applicable', () => {
    const source = {
      commitSha: 'a'.repeat(40),
      treeHash: 'b'.repeat(40),
      lockfileSha256: 'c'.repeat(64),
      worktreeClean: true,
    };
    const base = {
      profile: 'local-only',
      attendedEvidence: evidence(),
      sourceProvenance: source,
    } as const;
    expect(status(base, 'source-provenance')).toBe('passed');
    expect(status(base, 'performance-evidence')).toBe('passed');
    const dirty = { ...base, sourceProvenance: { ...source, worktreeClean: false } };
    expect(status(dirty, 'source-provenance')).toBe('failed');
    const malformed = { ...base, sourceProvenance: { ...source, treeHash: 'zz' } };
    expect(status(malformed, 'source-provenance')).toBe('failed');
    // The standard profile still wants browser evidence and a measured performance run.
    expect(status({ sourceProvenance: source }, 'source-provenance')).toBe('failed');
    expect(status({ sourceProvenance: source }, 'performance-evidence')).toBe('failed');
  });

  it('treats evidence the pure evaluator was not given like the other evidence fields', () => {
    expect(status({ profile: 'local-only' }, 'attended-journey')).toBe('passed');
    expect(status({ profile: 'local-only' }, 'lifecycle-evidence')).toBe('passed');
  });
});

describe('readAttendedEvidence', () => {
  it('reads the receipts under docs/release/attended/<sha> and the setup digest from SHA256SUMS.txt', () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-attended-'));
    try {
      const folder = join(root, 'docs', 'release', 'attended', CANDIDATE);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'restart-save-export.json'), JSON.stringify({ a: 1 }));
      // Windows PowerShell 5 writes a byte-order mark; the reader must accept it.
      writeFileSync(
        join(folder, 'sandbox-lifecycle.json'),
        String.fromCharCode(0xfeff) + JSON.stringify({ b: 2 }),
      );
      writeFileSync(join(folder, 'sandbox-upgrade.json'), '{not json');
      writeFileSync(join(folder, 'sandbox-upgrade-from-1.1.0.json'), JSON.stringify({ x: 3 }));
      mkdirSync(join(root, 'apps', 'desktop'), { recursive: true });
      writeFileSync(
        join(root, 'apps', 'desktop', 'package.json'),
        JSON.stringify({ version: CANDIDATE_VERSION }),
      );
      const releases = join(root, 'apps', 'desktop', 'dist', 'releases');
      mkdirSync(releases, { recursive: true });
      writeFileSync(
        join(releases, 'SHA256SUMS.txt'),
        `${'1'.repeat(64)}  joy-media.exe\n${SETUP.toUpperCase()}  joy-media-setup.exe\n`,
      );
      const found = readAttendedEvidence(root, CANDIDATE);
      expect(found?.setupSha256).toBe(SETUP);
      expect(found?.receipts['desktop.app.restart-save-export']).toEqual({ a: 1 });
      expect(found?.receipts['project.persistence.fresh-process']).toBeUndefined();
      expect(found?.sandboxLifecycle).toEqual({ b: 2 });
      expect(found?.sandboxUpgrade).toBeNull();
      expect(found?.sandboxUpgradeFrom110).toEqual({ x: 3 });
      expect(found?.candidateVersion).toBe(CANDIDATE_VERSION);
      expect(readAttendedEvidence(root, 'b'.repeat(40))).toBeNull();
      // The digest in SHA256SUMS.txt must describe the installer that is really there.
      expect(found?.bindingProblems?.join(';')).toMatch(/missing from the releases folder/u);
      writeFileSync(join(releases, 'joy-media-setup.exe'), 'not the tested installer');
      expect(readAttendedEvidence(root, CANDIDATE)?.bindingProblems?.join(';')).toMatch(
        /does not match its digest/u,
      );
      const bytes = 'the tested installer';
      writeFileSync(join(releases, 'joy-media-setup.exe'), bytes);
      writeFileSync(
        join(releases, 'SHA256SUMS.txt'),
        `${createHash('sha256').update(bytes).digest('hex')}  joy-media-setup.exe\n`,
      );
      expect(readAttendedEvidence(root, CANDIDATE)?.bindingProblems).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
