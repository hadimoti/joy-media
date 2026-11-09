import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FRESH_PROCESS_SCENARIO } from './attended-fresh-process.ts';
import { RESTART_SAVE_EXPORT } from './attended-scenario.ts';

/** The runner's command line, run as a child process. Nothing here passes a real candidate or --launch. */
const RUN_SCENARIO = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'attended',
  'run-scenario.mjs',
);
const PREFLIGHT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'attended',
  'attended-preflight.mjs',
);
const CANDIDATE = '5ee06a4a5cb0b4a0c06e0604346336196d4923ad';
const HASH = 'd1e7e6978ef4ae5a118580bd016461d2169213f88393c4002041dd7bd9cddbc1';
const MISSING_EXE = join(tmpdir(), 'no-such-candidate-folder', 'joy-media.exe');
const RUN_FILES = [
  'run.json',
  'receipt.json',
  'error.json',
  'plan-source',
  'profile-source',
  'profile-fresh',
];

// Every child process in this file runs with a stand-in home folder, so none of them reads the owner's real library,
// and nothing here depends on what that library holds. The stand-in holds an empty owner library folder.
let home: string;
let out: string;
let library: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cli-home-'));
  mkdirSync(join(home, 'joy-media-assets'));
  out = mkdtempSync(join(tmpdir(), 'cli-run-'));
  library = mkdtempSync(join(tmpdir(), 'cli-library-'));
  // A scratch library with a catalog, so the only failing check is the one each test is about.
  writeFileSync(join(library, 'catalog.json'), '{"version":1,"assets":[]}\n', 'utf8');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
  rmSync(library, { recursive: true, force: true });
});

/** The installed app's exe under the stand-in home, which a scenario must refuse. */
function installedExe(): string {
  return join(home, 'AppData', 'Local', 'Programs', 'JOY Media', 'joy-media.exe');
}

/** The environment of a child process whose home folder is the stand-in. */
function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home };
}

/** Runs the runner's command line as a child process, and returns its exit status and stderr. */
function runRunner(args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', RUN_SCENARIO, ...args],
    { encoding: 'utf8', timeout: 110_000, env: childEnv() },
  );
  return { status: result.status, stderr: result.stderr ?? '' };
}

/** Runs the standalone preflight as a child process, and returns its exit status and both output streams. */
function runPreflightProcess(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', PREFLIGHT, ...args], {
    encoding: 'utf8',
    timeout: 110_000,
    env: childEnv(),
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runCli(exe: string, extra: string[] = []): { status: number | null; stderr: string } {
  return runRunner([
    '--scenario',
    FRESH_PROCESS_SCENARIO,
    '--exe',
    exe,
    '--candidate',
    CANDIDATE,
    '--expected-exe-sha256',
    HASH,
    '--library',
    library,
    '--out',
    out,
    ...extra,
  ]);
}

/** The restart scenario's command line. Its source profile does not exist, so a refusal must not read it. */
function runRestart(exe: string, extra: string[] = []): { status: number | null; stderr: string } {
  return runRunner([
    '--scenario',
    RESTART_SAVE_EXPORT,
    '--exe',
    exe,
    '--candidate',
    CANDIDATE,
    '--expected-exe-sha256',
    HASH,
    '--library',
    library,
    '--out',
    out,
    '--profile',
    join(out, 'profile'),
    '--profile-source',
    join(out, 'no-source'),
    '--project',
    'project-1',
    ...extra,
  ]);
}

/** True when the run folder holds no run.json, receipt.json, error.json or profile folder. */
function writtenNoRunFile(): boolean {
  return RUN_FILES.every((name) => !existsSync(join(out, name)));
}

/** The preflight report the preflight wrote into the run folder. */
function readPreflight(): {
  ownerLibraryFiles: number;
  checks: { name: string; status: string }[];
} {
  return JSON.parse(readFileSync(join(out, 'preflight.json'), 'utf8')) as {
    ownerLibraryFiles: number;
    checks: { name: string; status: string }[];
  };
}

/** The names of the preflight checks that failed, as the preflight wrote them into the run folder. */
function failedPreflightChecks(): string[] {
  return readPreflight()
    .checks.filter((check) => check.status !== 'passed')
    .map((check) => check.name);
}

describe('the runner command line without --launch', () => {
  it('refuses an exe inside the installed folder before reading anything', () => {
    const result = runCli(installedExe());

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('inside the installed JOY Media folder');
    expect(existsSync(join(out, 'preflight.json'))).toBe(false);
    expect(readdirSync(out)).toEqual([]);
  }, 130_000);

  it('blocks a dry run whose exe is missing, on the exe check, and writes no run file', () => {
    const result = runCli(MISSING_EXE);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not ready');
    expect(failedPreflightChecks()).toContain('app-exe');
    expect(writtenNoRunFile()).toBe(true);
  }, 130_000);

  it('refuses a launch that approves no owner library count, before anything is read', () => {
    const result = runCli(MISSING_EXE, ['--launch']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--owner-library-files is required with --launch');
    expect(readdirSync(out)).toEqual([]);
  }, 130_000);

  it('refuses a dry run whose approved owner count differs, before the preflight writes anything', () => {
    const result = runCli(MISSING_EXE, ['--owner-library-files', '987654321']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not the 987654321 approved for this run');
    expect(result.stderr).toContain('nothing was written or started');
    expect(readdirSync(out)).toEqual([]);
  }, 130_000);

  it('refuses the restart scenario the same way, before it reads its source profile', () => {
    const result = runRestart(MISSING_EXE, ['--owner-library-files', '987654321']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not the 987654321 approved for this run');
    expect(readdirSync(out)).toEqual([]);
  }, 130_000);

  it('refuses an option the runner does not know, before anything is read', () => {
    const result = runCli(MISSING_EXE, ['--owner-library-file', '3221']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown option --owner-library-file');
    expect(readdirSync(out)).toEqual([]);
  }, 130_000);

  it('refuses the restart scenario from the installed folder before anything is read', () => {
    const result = runRestart(installedExe());

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('inside the installed JOY Media folder');
    expect(readdirSync(out)).toEqual([]);
  }, 130_000);

  it('refuses a launch whose approved owner library count is wrong, before anything is read', () => {
    const result = runCli(MISSING_EXE, ['--launch', '--owner-library-files', '987654321']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not the 987654321 approved for this run');
    expect(readdirSync(out)).toEqual([]);
  }, 130_000);

  it('refuses a dry run into a folder that holds a finished run, before the preflight writes anything', () => {
    writeFileSync(join(out, 'run.json'), '{}\n');
    const result = runCli(MISSING_EXE);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('already holds run.json');
    expect(existsSync(join(out, 'preflight.json'))).toBe(false);
  }, 130_000);

  it('refuses the standalone preflight in a folder that holds a finished run, and leaves that run alone', () => {
    writeFileSync(join(out, 'run.json'), '{"kept":true}\n');
    const result = runPreflightProcess([
      '--exe',
      MISSING_EXE,
      '--candidate',
      CANDIDATE,
      '--profile',
      join(out, 'profile'),
      '--library',
      library,
      '--out',
      out,
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('already holds run.json');
    expect(readFileSync(join(out, 'run.json'), 'utf8')).toBe('{"kept":true}\n');
    expect(existsSync(join(out, 'preflight.json'))).toBe(false);
  }, 130_000);

  it('refuses a folder that holds only an earlier preflight report, so that report is never overwritten', () => {
    writeFileSync(join(out, 'preflight.json'), '{"earlier":true}\n');
    const result = runCli(MISSING_EXE);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('already holds preflight.json');
    expect(readFileSync(join(out, 'preflight.json'), 'utf8')).toBe('{"earlier":true}\n');
  }, 130_000);

  it('refuses a scratch library that holds an owner folder, and writes nothing', () => {
    const result = runPreflightProcess([
      '--exe',
      MISSING_EXE,
      '--candidate',
      CANDIDATE,
      '--profile',
      join(out, 'profile'),
      '--library',
      home,
      '--out',
      out,
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('contains the protected folder');
    expect(existsSync(join(out, 'preflight.json'))).toBe(false);
  }, 130_000);

  it('refuses a scratch library that holds a junction, and writes nothing', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'cli-elsewhere-'));
    try {
      symlinkSync(elsewhere, join(library, 'jump'), 'junction');
      const result = runPreflightProcess([
        '--exe',
        MISSING_EXE,
        '--candidate',
        CANDIDATE,
        '--profile',
        join(out, 'profile'),
        '--library',
        library,
        '--out',
        out,
      ]);

      expect(result.status).toBe(2);
      expect(result.stdout).toContain('a link or an unreadable folder is in the library');
      expect(existsSync(join(out, 'preflight.json'))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 130_000);

  it('refuses a restart whose source profile holds a junction, before anything is read or copied', () => {
    const source = mkdtempSync(join(tmpdir(), 'cli-source-profile-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'cli-profile-elsewhere-'));
    try {
      symlinkSync(elsewhere, join(source, 'Cache'), 'junction');
      const result = runRunner([
        '--scenario',
        RESTART_SAVE_EXPORT,
        '--exe',
        MISSING_EXE,
        '--candidate',
        CANDIDATE,
        '--expected-exe-sha256',
        HASH,
        '--library',
        library,
        '--out',
        out,
        '--profile',
        join(out, 'profile'),
        '--profile-source',
        source,
        '--project',
        'project-1',
      ]);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('the source profile holds a link');
      expect(readdirSync(out)).toEqual([]);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 130_000);

  it('refuses a profile inside the working folder, so run files cannot land in a checkout', () => {
    const inCheckout = join(process.cwd(), 'attended-cli-test-profile-that-must-not-exist');
    const result = runPreflightProcess([
      '--exe',
      MISSING_EXE,
      '--candidate',
      CANDIDATE,
      '--profile',
      inCheckout,
      '--library',
      library,
      '--out',
      out,
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('inside the working folder');
    expect(existsSync(inCheckout)).toBe(false);
    expect(existsSync(join(out, 'preflight.json'))).toBe(false);
  }, 130_000);

  // The tests below put links and files into the stand-in home's owner library, and never into the real one.
  it('refuses a run whose owner library holds a junction, before the preflight writes anything', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'cli-owner-elsewhere-'));
    try {
      symlinkSync(elsewhere, join(home, 'joy-media-assets', 'exports'), 'junction');
      const result = runCli(MISSING_EXE);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('in the owner library');
      expect(readdirSync(out)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 130_000);

  it('refuses a run whose owner library is a junction whose target is gone', () => {
    const gone = join(home, 'gone-target');
    rmSync(join(home, 'joy-media-assets'), { recursive: true, force: true });
    mkdirSync(gone);
    symlinkSync(gone, join(home, 'joy-media-assets'), 'junction');
    rmSync(gone, { recursive: true, force: true });
    const result = runCli(MISSING_EXE);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('in the owner library');
    expect(readdirSync(out)).toEqual([]);
  }, 130_000);

  it('refuses the restart scenario for a junction in the owner library, before it reads its source profile', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'cli-owner-elsewhere-'));
    try {
      symlinkSync(elsewhere, join(home, 'joy-media-assets', 'exports'), 'junction');
      const result = runRestart(MISSING_EXE);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('in the owner library');
      expect(readdirSync(out)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 130_000);

  it('reports a junction in the owner library as a failed preflight check', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'cli-owner-elsewhere-'));
    try {
      symlinkSync(elsewhere, join(home, 'joy-media-assets', 'exports'), 'junction');
      const result = runPreflightProcess([
        '--exe',
        MISSING_EXE,
        '--candidate',
        CANDIDATE,
        '--profile',
        join(out, 'profile'),
        '--library',
        library,
        '--out',
        out,
      ]);

      expect(result.status).toBe(2);
      expect(failedPreflightChecks()).toContain('owner-library-no-link');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 130_000);

  it('does not count the files behind a linked owner library in the preflight', () => {
    const target = join(home, 'target');
    rmSync(join(home, 'joy-media-assets'), { recursive: true, force: true });
    mkdirSync(target);
    writeFileSync(join(target, 'x.bin'), '1');
    writeFileSync(join(target, 'y.bin'), '1');
    symlinkSync(target, join(home, 'joy-media-assets'), 'junction');
    const result = runPreflightProcess([
      '--exe',
      MISSING_EXE,
      '--candidate',
      CANDIDATE,
      '--profile',
      join(out, 'profile'),
      '--library',
      library,
      '--out',
      out,
    ]);

    expect(result.status).toBe(2);
    expect(readPreflight().ownerLibraryFiles).toBe(0);
    expect(failedPreflightChecks()).toEqual(
      expect.arrayContaining(['owner-library-no-link', 'owner-library-baseline']),
    );
  }, 130_000);

  it('refuses a dry run whose approved count differs from the owner library, and names both numbers', () => {
    writeFileSync(join(home, 'joy-media-assets', 'a.bin'), '1');
    const result = runCli(MISSING_EXE, ['--owner-library-files', '3']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'the owner library has 1 files, not the 3 approved for this run',
    );
    expect(readdirSync(out)).toEqual([]);
  }, 130_000);
});
