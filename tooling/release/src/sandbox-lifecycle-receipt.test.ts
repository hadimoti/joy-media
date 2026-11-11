import { describe, expect, it } from 'vitest';
import {
  REQUIRED_LIFECYCLE_STEPS,
  REQUIRED_UPGRADE_STEPS,
  SANDBOX_LIFECYCLE_SCHEMA,
  SANDBOX_UPGRADE_SCHEMA,
  validateSandboxLifecycle,
  validateSandboxUpgrade,
} from './sandbox-lifecycle-receipt.ts';

const SETUP = 'c'.repeat(64);
const OTHER = 'd'.repeat(64);

function steps(ids: readonly string[], digestId: string, digest: string) {
  return ids.map((id) => ({
    id,
    result: 'pass',
    detail: id === digestId ? digest : 'ok',
  }));
}

function lifecycle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: SANDBOX_LIFECYCLE_SCHEMA,
    startedAt: '2026-11-12T10:00:00.000Z',
    finishedAt: '2026-11-12T10:01:00.000Z',
    identity: { user: 'WDAGUtilityAccount', computer: 'SANDBOX', administrator: true },
    steps: steps(REQUIRED_LIFECYCLE_STEPS, 'setup-digest', SETUP),
    beforeInstall: { installFolderExists: false },
    afterInstall: { installFolderExists: true, installFileCount: 1024, uninstallKey: true },
    afterUninstall: {
      installFolderExists: false,
      uninstallKey: false,
      pathHasJoy: false,
      desktopShortcut: false,
      startMenuShortcut: false,
    },
    ...overrides,
  };
}

function upgrade(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: SANDBOX_UPGRADE_SCHEMA,
    startedAt: '2026-11-12T10:00:00.000Z',
    finishedAt: '2026-11-12T10:02:00.000Z',
    identity: { user: 'WDAGUtilityAccount' },
    steps: steps(REQUIRED_UPGRADE_STEPS, 'new-setup-digest', SETUP),
    'S1-v102-installed': { appPackageVersion: '1.0.2' },
    'S3-upgraded': { appPackageVersion: '1.1.0', uninstallDisplayVersion: '1.1.0' },
    'S4-v110-after-run': { dataFolderExists: true },
    'S5-uninstalled': { installFolderExists: false, dataFolderExists: true, pathEntries: 0 },
    ...overrides,
  };
}

describe('sandbox lifecycle receipt', () => {
  it('accepts a complete run on the candidate setup', () => {
    expect(validateSandboxLifecycle(lifecycle(), { setupSha256: SETUP })).toEqual([]);
  });

  it('refuses anything that is not an object', () => {
    expect(validateSandboxLifecycle(null, { setupSha256: SETUP })).toEqual([
      'receipt is not a JSON object',
    ]);
  });

  it('refuses a run on another setup', () => {
    const run = lifecycle({ steps: steps(REQUIRED_LIFECYCLE_STEPS, 'setup-digest', OTHER) });
    expect(validateSandboxLifecycle(run, { setupSha256: SETUP }).join(';')).toMatch(
      /not the candidate setup/u,
    );
  });

  it('refuses a missing or failed step and a recorded error', () => {
    const missing = lifecycle({
      steps: steps(REQUIRED_LIFECYCLE_STEPS, 'setup-digest', SETUP).filter(
        (s) => s.id !== 'uninstall',
      ),
    });
    expect(validateSandboxLifecycle(missing, { setupSha256: SETUP }).join(';')).toMatch(
      /step uninstall is missing/u,
    );
    const failed = lifecycle({
      steps: [
        ...steps(REQUIRED_LIFECYCLE_STEPS, 'setup-digest', SETUP).filter(
          (s) => s.id !== 'folder-removed',
        ),
        { id: 'folder-removed', result: 'fail', detail: 'still there' },
      ],
    });
    expect(validateSandboxLifecycle(failed, { setupSha256: SETUP }).join(';')).toMatch(
      /step folder-removed did not pass/u,
    );
    const errored = lifecycle({
      steps: [
        ...steps(REQUIRED_LIFECYCLE_STEPS, 'setup-digest', SETUP),
        { id: 'error', result: 'fail', detail: 'boom' },
      ],
    });
    expect(validateSandboxLifecycle(errored, { setupSha256: SETUP }).join(';')).toMatch(
      /error step/u,
    );
  });

  it('refuses a run outside the Sandbox user and a dirty Sandbox', () => {
    expect(
      validateSandboxLifecycle(lifecycle({ identity: { user: 'HadiMoti' } }), {
        setupSha256: SETUP,
      }).join(';'),
    ).toMatch(/Sandbox user/u);
    expect(
      validateSandboxLifecycle(lifecycle({ beforeInstall: { installFolderExists: true } }), {
        setupSha256: SETUP,
      }).join(';'),
    ).toMatch(/not clean/u);
  });

  it('refuses leftovers after the uninstall', () => {
    const run = lifecycle({
      afterUninstall: {
        installFolderExists: true,
        uninstallKey: true,
        pathHasJoy: true,
        desktopShortcut: true,
        startMenuShortcut: false,
      },
    });
    const text = validateSandboxLifecycle(run, { setupSha256: SETUP }).join(';');
    expect(text).toMatch(/install folder is still there/u);
    expect(text).toMatch(/registration is still there/u);
    expect(text).toMatch(/user PATH/u);
    expect(text).toMatch(/shortcut/u);
  });
});

describe('sandbox upgrade receipt', () => {
  it('accepts a complete upgrade on the candidate setup', () => {
    expect(validateSandboxUpgrade(upgrade(), { setupSha256: SETUP })).toEqual([]);
  });

  it('refuses a wrong version, lost data, and a PATH entry left behind', () => {
    const run = upgrade({
      'S3-upgraded': { appPackageVersion: '1.0.2', uninstallDisplayVersion: '1.0.2' },
      'S4-v110-after-run': { dataFolderExists: false },
      'S5-uninstalled': { installFolderExists: false, dataFolderExists: true, pathEntries: 1 },
    });
    const text = validateSandboxUpgrade(run, { setupSha256: SETUP }).join(';');
    expect(text).toMatch(/did not leave version 1\.1\.0/u);
    expect(text).toMatch(/app data folder is gone/u);
    expect(text).toMatch(/user PATH/u);
  });

  it('refuses an upgrade that did not start from v1.0.2 or lost the marker file', () => {
    const run = upgrade({
      'S1-v102-installed': { appPackageVersion: '1.1.0' },
      steps: [
        ...steps(REQUIRED_UPGRADE_STEPS, 'new-setup-digest', SETUP).filter(
          (s) => s.id !== 'data-marker-kept',
        ),
        { id: 'data-marker-kept', result: 'fail', detail: 'upgrade-marker.txt' },
      ],
    });
    const text = validateSandboxUpgrade(run, { setupSha256: SETUP }).join(';');
    expect(text).toMatch(/not v1\.0\.2/u);
    expect(text).toMatch(/step data-marker-kept did not pass/u);
  });
});
