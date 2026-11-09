#!/usr/bin/env node
// Preflight for an attended (owner-at-PC) run. It changes nothing on the machine except files in
// the run folder: it hashes the candidate app, exports the joy:// key with reg.exe into the run
// folder, checks that the run paths stay out of the owner's protected folders, checks the scratch
// asset library and the tools, and writes preflight.json. It never launches the app.
//
// Usage (Windows, from the repository root):
//   node --experimental-strip-types tooling/release/attended/attended-preflight.mjs \
//     --exe <path to joy-media.exe in an unpacked copy> --candidate <40-hex commit> \
//     --profile <new profile folder> --library <scratch library folder> --out <run folder> \
//     [--reuse-profile]
// Exit codes: 0 ready, 2 blocked, 1 usage error.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOY_KEY_EXPECTED_SHA256 } from '../src/attended-receipt.ts';
import { isInside, samePath } from './scenario-rules.mjs';

export const PREFLIGHT_SCHEMA = 'joy-media.attended-preflight/1';

const CANDIDATE_PATTERN = /^[0-9a-f]{40}$/u;

function parseArgs(argv) {
  const options = { reuseProfile: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--reuse-profile') {
      options.reuseProfile = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
    options[arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  for (const required of ['exe', 'candidate', 'profile', 'library', 'out']) {
    if (typeof options[required] !== 'string' || options[required] === '') {
      throw new Error(`--${required} is required`);
    }
  }
  return options;
}

function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

function countFiles(directory) {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += countFiles(path);
    else if (entry.isFile()) total += 1;
  }
  return total;
}

/** The owner's folders that a run must never write to, derived from the user's home folder. */
export function protectedRoots(home) {
  return [
    join(home, 'joy-media-assets'),
    join(home, 'Desktop'),
    join(home, 'Downloads'),
    join(home, 'joy-media'),
    join(home, 'AppData', 'Local', 'Programs', 'JOY Media'),
    join(home, 'AppData', 'Roaming', '@joy-media'),
    join(home, 'AppData', 'Roaming', 'JOY Media'),
  ];
}

function check(checks, name, status, detail) {
  checks.push({ name, status, detail });
}

async function runPreflight(options) {
  const checks = [];
  const home = homedir();
  const defaultLibrary = join(home, 'joy-media-assets');
  const exe = resolve(options.exe);
  const unpackedDir = resolve(exe, '..');
  const candidateOk = CANDIDATE_PATTERN.test(options.candidate);
  check(
    checks,
    'candidate-sha',
    candidateOk ? 'passed' : 'failed',
    candidateOk ? options.candidate : 'candidate must be a full lowercase commit SHA',
  );

  const exeOk = isAbsolute(options.exe) && existsSync(exe) && basename(exe) === 'joy-media.exe';
  let exeSha256 = '';
  if (exeOk) exeSha256 = await sha256File(exe);
  check(
    checks,
    'app-exe',
    exeOk ? 'passed' : 'failed',
    exeOk ? exeSha256 : 'joy-media.exe must exist at an absolute path',
  );

  const playwright = join(unpackedDir, 'resources', 'app', 'node_modules', 'playwright-core');
  check(
    checks,
    'playwright-core-present',
    existsSync(playwright) ? 'passed' : 'failed',
    existsSync(playwright) ? 'present' : 'missing: the Worker would die and exports would hang',
  );

  // Real paths are compared, so a junction, a link or a short name cannot hide a protected folder.
  for (const name of ['profile', 'library', 'out']) {
    const value = resolve(options[name]);
    const inside = protectedRoots(home).find((root) => isInside(value, root));
    check(
      checks,
      `${name}-outside-owner-folders`,
      inside === undefined ? 'passed' : 'failed',
      inside === undefined ? value : `${value} is inside the protected folder ${inside}`,
    );
  }

  const profile = resolve(options.profile);
  const profileExists = existsSync(profile);
  const profileOk = options.reuseProfile ? profileExists : !profileExists;
  check(
    checks,
    'profile-is-fresh-or-declared',
    profileOk ? 'passed' : 'failed',
    options.reuseProfile
      ? profileExists
        ? 'reusing an existing profile (declared)'
        : 'declared reuse, but the profile does not exist'
      : profileExists
        ? 'profile exists: use a new folder or --reuse-profile'
        : 'new profile folder',
  );

  const library = resolve(options.library);
  const catalogOk = existsSync(join(library, 'catalog.json'));
  const notDefault = !samePath(library, defaultLibrary);
  check(
    checks,
    'scratch-library-ready',
    catalogOk && notDefault ? 'passed' : 'failed',
    !notDefault
      ? 'the library is the owner default library'
      : catalogOk
        ? 'catalog.json present'
        : 'catalog.json missing (create the minimal catalog first)',
  );

  let ownerLibraryFiles = 0;
  if (existsSync(defaultLibrary)) {
    ownerLibraryFiles = countFiles(defaultLibrary);
    check(checks, 'owner-library-baseline', 'passed', `${ownerLibraryFiles} files counted`);
  } else {
    check(checks, 'owner-library-baseline', 'passed', 'default library folder not present');
  }

  for (const tool of ['ffmpeg', 'ffprobe']) {
    const result = spawnSync(tool, ['-version'], { encoding: 'utf8' });
    check(
      checks,
      `${tool}-on-path`,
      result.status === 0 ? 'passed' : 'failed',
      result.status === 0 ? 'found' : `${tool} not found`,
    );
  }

  if (process.platform !== 'win32') {
    check(checks, 'windows-host', 'failed', 'attended runs need Windows (reg.exe and tasklist)');
  } else {
    const tasks = spawnSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq joy-media.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8' },
    );
    const running = /joy-media\.exe/iu.test(tasks.stdout ?? '');
    check(
      checks,
      'no-joy-media-process',
      running ? 'failed' : 'passed',
      running ? 'a joy-media.exe process is running' : 'none running',
    );
  }

  // A run path inside an owner folder is refused before anything is written there, so a refused run
  // leaves no file behind. The key is not exported in that case.
  const protectedHit = checks.some(
    (item) => item.name.endsWith('-outside-owner-folders') && item.status === 'failed',
  );
  if (!protectedHit) mkdirSync(resolve(options.out), { recursive: true });
  const keyFile = join(resolve(options.out), 'joy-key-before.reg');
  let joyKeyBefore = '';
  if (!protectedHit && process.platform === 'win32') {
    const exported = spawnSync(
      'reg.exe',
      ['export', 'HKCU\\Software\\Classes\\joy', keyFile, '/y'],
      { encoding: 'utf8' },
    );
    if (exported.status === 0 && existsSync(keyFile)) joyKeyBefore = await sha256File(keyFile);
  }
  // reg.exe writes UTF-16 text. Read the command value so a blocked run says what the key pointed to.
  let joyCommandBefore = '';
  if (joyKeyBefore !== '') {
    const match =
      /\[HKEY_CURRENT_USER\\Software\\Classes\\joy\\shell\\open\\command\]\r?\n@="((?:[^"\\]|\\.)*)"/u.exec(
        readFileSync(keyFile, 'utf16le'),
      );
    joyCommandBefore = match ? match[1] : '';
  }
  const keyOk = joyKeyBefore === JOY_KEY_EXPECTED_SHA256;
  check(
    checks,
    'joy-key-matches-expected',
    keyOk ? 'passed' : 'failed',
    protectedHit
      ? 'not checked: a run path is inside a protected folder'
      : keyOk
        ? joyKeyBefore
        : `joy:// key hash is ${joyKeyBefore || 'unavailable'} (command ${joyCommandBefore || 'unknown'}); expected ${JOY_KEY_EXPECTED_SHA256}`,
  );

  const blockers = checks
    .filter((item) => item.status !== 'passed')
    .map((item) => `${item.name}: ${item.detail}`);
  return {
    schema: PREFLIGHT_SCHEMA,
    createdAt: new Date().toISOString(),
    candidateSha: options.candidate,
    exe: { path: exe, sha256: exeSha256 },
    unpackedDir,
    paths: { profile, library, out: resolve(options.out) },
    ownerLibraryFiles,
    joyKeyBefore,
    joyCommandBefore,
    checks,
    verdict: blockers.length === 0 ? 'ready' : 'blocked',
    blockers,
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`usage error: ${error.message}\n`);
    process.exit(1);
  }
  const report = await runPreflight(options);
  const path = join(resolve(options.out), 'preflight.json');
  if (
    report.checks.some(
      (item) => item.name.endsWith('-outside-owner-folders') && item.status === 'failed',
    )
  ) {
    for (const item of report.checks)
      process.stdout.write(`${item.status.padEnd(7)} ${item.name}: ${item.detail}\n`);
    process.stdout.write(
      'verdict: blocked (nothing written: a run path is inside a protected folder)\n',
    );
    process.exit(2);
  }
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  for (const item of report.checks)
    process.stdout.write(`${item.status.padEnd(7)} ${item.name}: ${item.detail}\n`);
  process.stdout.write(`verdict: ${report.verdict} (${path})\n`);
  process.exit(report.verdict === 'ready' ? 0 : 2);
}

// The entry check compares real paths, so the file runs however its path is written (case, links).
if (process.argv[1] !== undefined && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  await main();
}
