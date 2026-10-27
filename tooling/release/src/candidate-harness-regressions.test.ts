import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guards for the four harness defects found in the D18 shadow runs. Each guard has a positive control: the same check
// must flag a snippet of the defective form, so a check that passes everything cannot pass unnoticed.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/** The lifecycle harness assigns the DPAPI fixture folder to $userDataDirectory once, and the installed folder to its own name. */
export function lifecycleUserDataFindings(source: string): string[] {
  const findings: string[] = [];
  const assignments = source.match(/^\s*\$userDataDirectory\s*=/gmu) ?? [];
  if (assignments.length !== 1) {
    findings.push(
      `$userDataDirectory is assigned ${assignments.length} times; only the fixture folder may use it`,
    );
  }
  if (/^\s*\$userDataDirectory\s*=\s*Get-InstalledUserDataDirectory/mu.test(source)) {
    findings.push('the installed data folder is assigned to $userDataDirectory');
  }
  return findings;
}

/** The installer integrity check takes the launcher folder and names from the product layout, and expects no root launcher. */
export function installerLauncherFindings(source: string): string[] {
  const findings: string[] = [];
  if (!source.includes("from '../../apps/desktop/scripts/cli-launcher-layout.mjs'")) {
    findings.push('the check does not import the launcher layout from the product');
  }
  if (/^\s*'joy\.cmd',\s*$/mu.test(source)) {
    findings.push("the check still requires 'joy.cmd' in the install root");
  }
  return findings;
}

/** The installed CLI acceptance reads joy-media.exe and the packaged files from the install root above the launcher's bin folder. */
export function installedCliRootFindings(source: string): string[] {
  const findings: string[] = [];
  if (/join\(dirname\(launcherPath\), '(?:joy-media\.exe|resources)'/u.test(source)) {
    findings.push('a packaged file is resolved next to the launcher instead of the install root');
  }
  if (
    !source.includes(
      "CLI_LAUNCHER_DIRECTORY } from '../../apps/desktop/scripts/cli-launcher-layout.mjs'",
    )
  ) {
    findings.push('the acceptance does not import the launcher folder from the product layout');
  }
  return findings;
}

/** A shadow workflow provisions FFmpeg from the pinned, digest-checked build, not from an unbounded apt install. */
export function provisioningFindings(source: string): string[] {
  const findings: string[] = [];
  if (/apt-get\s+install/u.test(source)) findings.push('FFmpeg is installed with apt-get');
  if (
    !source.includes(
      'FFMPEG_SHA256: d0eb612b8994407f78413e2929cb4b073bc699c8ab79e198b31624736fdc2f93',
    )
  ) {
    findings.push('the pinned FFmpeg digest is missing');
  }
  return findings;
}

describe('lifecycle harness: the DPAPI fixture folder is not replaced by the installed folder', () => {
  it('the fixed harness assigns the fixture folder once and keeps the installed folder under its own name', () => {
    expect(lifecycleUserDataFindings(read('tests/desktop/windows-lifecycle.ps1'))).toEqual([]);
    expect(read('tests/desktop/windows-lifecycle.ps1')).toMatch(
      /\$installedUserDataDirectory = Get-InstalledUserDataDirectory/u,
    );
  });

  it('positive control: the defective reassignment is flagged', () => {
    const defective = [
      '$userDataDirectory = Join-Path $workRoot "profile"',
      '    $userDataDirectory = Get-InstalledUserDataDirectory',
      '    $snapshot = Join-Path $userDataDirectory "backups"',
    ].join('\n');
    expect(lifecycleUserDataFindings(defective).length).toBeGreaterThan(0);
  });
});

describe('installer integrity check: the launchers are read from the bin folder, not the install root', () => {
  it('the check follows the product launcher layout and keeps launchers out of the root', () => {
    expect(installerLauncherFindings(read('tests/desktop/installer-package-check.mjs'))).toEqual(
      [],
    );
  });

  it('positive control: a root-level launcher requirement is flagged', () => {
    const defective = [
      'const requiredFiles = [',
      "  'joy-media.exe',",
      "  'joy.cmd',",
      "  'joy-media.cmd',",
      '];',
    ].join('\n');
    expect(installerLauncherFindings(defective).length).toBeGreaterThan(0);
  });
});

describe('installed CLI acceptance: the packaged files are read from the install root above bin', () => {
  it('the acceptance resolves joy-media.exe, the bundle and the worker from the install root', () => {
    expect(installedCliRootFindings(read('tests/desktop/installed-cli-acceptance.mjs'))).toEqual(
      [],
    );
  });

  it('positive control: a file resolved next to the launcher is flagged', () => {
    const defective = [
      "import { dirname, join } from 'node:path';",
      "assert.ok(existsSync(join(dirname(launcherPath), 'joy-media.exe')));",
    ].join('\n');
    expect(installedCliRootFindings(defective).length).toBeGreaterThan(0);
  });
});

/** The v3 shard job runs `pnpm typecheck` (tsc -b) before its Vitest shard, as the development verification's check does. */
export function shardPrerequisiteFindings(source: string): string[] {
  const shardStart = source.indexOf('  hosted-verify-shard:');
  const shardRun = source.indexOf('--shard=', shardStart);
  const typecheck = source.indexOf('pnpm typecheck', shardStart);
  const findings: string[] = [];
  if (shardStart < 0 || shardRun < 0) {
    findings.push('the shard job or its Vitest shard step is missing');
  } else if (typecheck < 0 || typecheck > shardRun) {
    findings.push('the shard job does not run pnpm typecheck before the Vitest shard');
  }
  return findings;
}

describe('v3 shard job: the project references are emitted before the shard runs', () => {
  it('the shard job runs pnpm typecheck before its Vitest shard', () => {
    expect(shardPrerequisiteFindings(read('.github/workflows/release-candidate-v3.yml'))).toEqual(
      [],
    );
  });

  it('positive control: a shard job without the typecheck step is flagged', () => {
    const defective = [
      '  hosted-verify-shard:',
      '    steps:',
      '      - run: pnpm install --frozen-lockfile',
      '      - run: node node_modules/vitest/vitest.mjs run --retry=0 --shard=1/3',
    ].join('\n');
    expect(shardPrerequisiteFindings(defective).length).toBeGreaterThan(0);
  });
});

/** The collection runs after the media and browser toolchain the shards install, so a suite gated on them registers the same way. */
export function collectionPrerequisiteFindings(source: string): string[] {
  const jobStart = source.indexOf('  hosted-prepare:');
  if (jobStart < 0) return ['the hosted-prepare job is missing'];
  const jobEnd = source.indexOf('\n  hosted-verify:', jobStart);
  const job = source.slice(jobStart, jobEnd > jobStart ? jobEnd : undefined);
  const collection = job.indexOf('vitest.mjs list --json');
  if (collection < 0) return ['the hosted-prepare job has no collection step'];
  const findings: string[] = [];
  const prerequisites = [
    ['pnpm typecheck', 'the project references are not emitted'],
    [
      'FFMPEG_SHA256: d0eb612b8994407f78413e2929cb4b073bc699c8ab79e198b31624736fdc2f93',
      'the pinned FFmpeg is not installed',
    ],
    ['pnpm exec playwright install --with-deps chromium', 'Chromium is not installed'],
  ] as const;
  for (const [needle, reason] of prerequisites) {
    const at = job.indexOf(needle);
    if (at < 0 || at > collection) findings.push(`the collection runs before ${reason}`);
  }
  return findings;
}

describe('collection: the hosted-prepare job lists the tests in the toolchain the shards run', () => {
  it('the collection runs after typecheck, the pinned FFmpeg and Chromium are in place', () => {
    expect(
      collectionPrerequisiteFindings(read('.github/workflows/release-candidate-v3.yml')),
    ).toEqual([]);
  });

  it('positive control: a collection that runs before the toolchain is flagged', () => {
    const defective = [
      '  hosted-prepare:',
      '    steps:',
      '      - run: pnpm install --frozen-lockfile',
      '      - run: node node_modules/vitest/vitest.mjs list --json > test-output/hosted-verify/prep/list.json',
      '      - run: pnpm typecheck',
      '      - env:',
      '          FFMPEG_SHA256: d0eb612b8994407f78413e2929cb4b073bc699c8ab79e198b31624736fdc2f93',
      '        run: pnpm exec playwright install --with-deps chromium',
    ].join('\n');
    expect(collectionPrerequisiteFindings(defective)).toHaveLength(3);
  });
});

describe('shadow workflows: FFmpeg comes from the pinned, digest-checked build', () => {
  it('the v2 and v3 workflows contain no unbounded apt install of FFmpeg', () => {
    expect(provisioningFindings(read('.github/workflows/release-candidate-v2.yml'))).toEqual([]);
    expect(provisioningFindings(read('.github/workflows/release-candidate-v3.yml'))).toEqual([]);
  });

  it('positive control: the apt install of FFmpeg is flagged', () => {
    const defective = ['run: |', '  sudo apt-get update', '  sudo apt-get install -y ffmpeg'].join(
      '\n',
    );
    expect(provisioningFindings(defective).length).toBeGreaterThan(0);
  });
});
