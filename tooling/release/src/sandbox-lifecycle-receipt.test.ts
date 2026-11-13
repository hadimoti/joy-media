import { describe, expect, it } from 'vitest';
import {
  REQUIRED_LIFECYCLE_STEPS,
  SANDBOX_LIFECYCLE_SCHEMA,
  SANDBOX_UPGRADE_SCHEMA,
  requiredUpgradeSteps,
  validateSandboxLifecycle,
  validateSandboxUpgrade,
  versionTag,
} from './sandbox-lifecycle-receipt.ts';

const SETUP = 'c'.repeat(64);
const OTHER = 'd'.repeat(64);
const FROM_SETUP = 'f'.repeat(64);

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
      joyKey: null,
      desktopShortcut: false,
      startMenuShortcut: false,
    },
    ...overrides,
  };
}

/**
 * A fake upgrade receipt from `from` to `to`. A v1.0.2 start is a zip run (the shape of the
 * receipt written before the run recorded its versions); any other start is an installer run.
 */
function upgrade(
  overrides: Record<string, unknown> = {},
  from = '1.0.2',
  to = '1.1.0',
): Record<string, unknown> {
  const fromTag = versionTag(from);
  const toTag = versionTag(to);
  const fromMode = from === '1.0.2' ? 'zip' : 'setup';
  const ids = requiredUpgradeSteps(from, to, fromMode);
  return {
    schema: SANDBOX_UPGRADE_SCHEMA,
    startedAt: '2026-11-12T10:00:00.000Z',
    finishedAt: '2026-11-12T10:02:00.000Z',
    identity: { user: 'WDAGUtilityAccount' },
    fromVersion: from,
    fromMode,
    steps: ids.map((id) => ({
      id,
      result: 'pass',
      detail: id === 'new-setup-digest' ? SETUP : id.endsWith('-digest') ? FROM_SETUP : 'ok',
    })),
    [`S1-${fromTag}-installed`]: { appPackageVersion: from },
    'S3-upgraded': { appPackageVersion: to, uninstallDisplayVersion: to },
    [`S4-${toTag}-after-run`]: { dataFolderExists: true },
    'S5-uninstalled': {
      installFolderExists: false,
      dataFolderExists: true,
      pathEntries: 0,
      joyKey: null,
    },
    ...overrides,
  };
}

const EXPECT_110 = { setupSha256: SETUP, fromVersion: '1.0.2', toVersion: '1.1.0' };

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
        joyKey: 'C:/gone/joy-media.exe',
        desktopShortcut: true,
        startMenuShortcut: false,
      },
    });
    const text = validateSandboxLifecycle(run, { setupSha256: SETUP }).join(';');
    expect(text).toMatch(/install folder is still there/u);
    expect(text).toMatch(/registration is still there/u);
    expect(text).toMatch(/user PATH/u);
    expect(text).toMatch(/joy:\/\/ registration/u);
    expect(text).toMatch(/shortcut/u);
  });
});

describe('sandbox upgrade receipt', () => {
  it('accepts a complete upgrade from v1.0.2 to the candidate', () => {
    expect(validateSandboxUpgrade(upgrade(), EXPECT_110)).toEqual([]);
  });

  it('accepts a complete upgrade from v1.1.0 to a later candidate, with the after version as a parameter', () => {
    const run = upgrade({}, '1.1.0', '1.1.1');
    expect(
      validateSandboxUpgrade(run, {
        setupSha256: SETUP,
        fromVersion: '1.1.0',
        toVersion: '1.1.1',
        fromSha256: FROM_SETUP,
      }),
    ).toEqual([]);
    // The same run is refused when the candidate is not the version it ended on.
    expect(
      validateSandboxUpgrade(run, { setupSha256: SETUP, fromVersion: '1.1.0', toVersion: '1.1.0' }),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/different version/u)]));
  });

  it('accepts a receipt from before the run recorded its versions as a v1.0.2 upgrade', () => {
    const legacy = upgrade({ fromVersion: undefined, fromMode: undefined });
    expect(validateSandboxUpgrade(legacy, EXPECT_110)).toEqual([]);
  });

  it('refuses a start version other than 1.0.2 or 1.1.0', () => {
    const run = upgrade({ fromVersion: '1.0.1' }, '1.0.1', '1.1.0');
    const text = validateSandboxUpgrade(run, {
      setupSha256: SETUP,
      fromVersion: '1.0.1',
      toVersion: '1.1.0',
    }).join(';');
    expect(text).toMatch(/must start from 1\.0\.2 or 1\.1\.0, not 1\.0\.1/u);
  });

  it('refuses a receipt for a different start version than the one the gate asked for', () => {
    const text = validateSandboxUpgrade(upgrade({}, '1.1.0', '1.1.1'), {
      setupSha256: SETUP,
      fromVersion: '1.0.2',
      toVersion: '1.1.1',
    }).join(';');
    expect(text).toMatch(/upgrade from 1\.1\.0, not 1\.0\.2/u);
  });

  it('refuses a zip install from any version but 1.0.2, and an after version that is not x.y.z', () => {
    const zipFrom110 = upgrade({ fromMode: 'zip' }, '1.1.0', '1.1.1');
    expect(
      validateSandboxUpgrade(zipFrom110, {
        setupSha256: SETUP,
        fromVersion: '1.1.0',
        toVersion: '1.1.1',
      }).join(';'),
    ).toMatch(/only v1\.0\.2 comes from a zip/u);
    const text = validateSandboxUpgrade(upgrade(), {
      setupSha256: SETUP,
      fromVersion: '1.0.2',
      toVersion: '',
    }).join(';');
    expect(text).toMatch(/after version is not x\.y\.z/u);
  });

  it('refuses a receipt whose recorded after version is not the expected one', () => {
    const text = validateSandboxUpgrade(upgrade({ toVersion: '1.1.2' }), EXPECT_110).join(';');
    expect(text).toMatch(/recorded version 1\.1\.2 as the after version/u);
  });

  it('refuses an installer from v1.1.0 that is not the given setup', () => {
    const run = upgrade({}, '1.1.0', '1.1.1');
    const text = validateSandboxUpgrade(run, {
      setupSha256: SETUP,
      fromVersion: '1.1.0',
      toVersion: '1.1.1',
      fromSha256: 'a'.repeat(64),
    }).join(';');
    expect(text).toMatch(/not the 1\.1\.0 setup given/u);
  });

  it('refuses a wrong version, lost data, and a PATH entry left behind', () => {
    const run = upgrade({
      'S3-upgraded': { appPackageVersion: '1.0.2', uninstallDisplayVersion: '1.0.2' },
      'S4-v110-after-run': { dataFolderExists: false },
      'S5-uninstalled': { installFolderExists: false, dataFolderExists: true, pathEntries: 1 },
    });
    const text = validateSandboxUpgrade(run, EXPECT_110).join(';');
    expect(text).toMatch(/did not leave version 1\.1\.0/u);
    expect(text).toMatch(/app data folder is gone/u);
    expect(text).toMatch(/user PATH/u);
  });

  it('refuses an upgrade that did not start from the stated version or lost the marker file', () => {
    const ids = requiredUpgradeSteps('1.0.2', '1.1.0', 'zip').filter(
      (id) => id !== 'data-marker-kept',
    );
    const run = upgrade({
      'S1-v102-installed': { appPackageVersion: '1.1.0' },
      steps: [
        ...ids.map((id) => ({ id, result: 'pass', detail: 'ok' })),
        { id: 'data-marker-kept', result: 'fail', detail: 'upgrade-marker.txt' },
      ],
    });
    const text = validateSandboxUpgrade(run, EXPECT_110).join(';');
    expect(text).toMatch(/not v1\.0\.2/u);
    expect(text).toMatch(/step data-marker-kept did not pass/u);
  });
});
