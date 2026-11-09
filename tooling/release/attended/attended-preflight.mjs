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
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOY_KEY_EXPECTED_SHA256 } from '../src/attended-receipt.ts';
import {
  countFiles,
  findOnPath,
  isInside,
  linkInside,
  linkOnPath,
  ownerDefaultLibrary,
  runFolderProblem,
  samePath,
  systemTool,
  unexpectedRunArtifacts,
} from './scenario-rules.mjs';

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

/** The owner's folders that a run must never write to, derived from the user's home folder. */
export function protectedRoots(home) {
  return [
    ownerDefaultLibrary(home),
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

/** True for a failed check that refuses a run path. Nothing is written when one of these fails. */
function isPathBlock(item) {
  const suffixes = ['-outside-owner-folders', '-outside-working-folder', '-has-no-link'];
  const names = ['library-tree-has-no-link', 'library-apart-from-run-paths'];
  return (
    item.status === 'failed' &&
    (names.includes(item.name) || suffixes.some((suffix) => item.name.endsWith(suffix)))
  );
}

async function runPreflight(options) {
  const checks = [];
  const home = homedir();
  const installedFolder = join(home, 'AppData', 'Local', 'Programs', 'JOY Media');
  const defaultLibrary = ownerDefaultLibrary(home);
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
  // A scenario never runs the installed app, so an exe inside the installed folder is a blocker here too.
  const insideInstalled = exeOk && isInside(exe, installedFolder);
  check(
    checks,
    'exe-outside-installed-folder',
    insideInstalled ? 'failed' : 'passed',
    insideInstalled
      ? 'the exe is inside the installed JOY Media folder, which a scenario never runs'
      : 'outside the installed folder',
  );

  const playwright = join(unpackedDir, 'resources', 'app', 'node_modules', 'playwright-core');
  check(
    checks,
    'playwright-core-present',
    existsSync(playwright) ? 'passed' : 'failed',
    existsSync(playwright) ? 'present' : 'missing: the Worker would die and exports would hang',
  );

  // Real paths are compared, so a junction, a link or a short name cannot hide a protected folder.
  // Real paths are compared both ways: a run path inside a protected folder, or one that holds a protected folder, is refused.
  for (const name of ['profile', 'library', 'out']) {
    const value = resolve(options[name]);
    const root = protectedRoots(home).find(
      (item) => isInside(value, item) || isInside(item, value),
    );
    const inside = root !== undefined && isInside(value, root);
    let detail = value;
    if (root !== undefined) {
      detail = inside
        ? `${value} is inside the protected folder ${root}`
        : `${value} contains the protected folder ${root}`;
    }
    check(
      checks,
      `${name}-outside-owner-folders`,
      root === undefined ? 'passed' : 'failed',
      detail,
    );
  }

  // The scratch library must not contain, or be contained by, the output or the profile: run files would land in the
  // folder the app catalogues.
  const libraryValue = resolve(options.library);
  const apart = [resolve(options.out), resolve(options.profile)].some(
    (run) => isInside(run, libraryValue) || isInside(libraryValue, run),
  );
  check(
    checks,
    'library-apart-from-run-paths',
    apart ? 'failed' : 'passed',
    apart
      ? 'the library contains, or is inside, the output or the profile'
      : 'the library is apart',
  );

  // A run writes its files into its own folders. One inside the working folder (a checkout) would put run files where
  // they could be committed, so it is refused like a protected folder.
  const working = resolve(process.cwd());
  for (const name of ['profile', 'library', 'out']) {
    const value = resolve(options[name]);
    const inWorking = isInside(value, working);
    check(
      checks,
      `${name}-outside-working-folder`,
      inWorking ? 'failed' : 'passed',
      inWorking ? `${value} is inside the working folder ${working}` : 'outside the working folder',
    );
  }

  // A link or a junction anywhere on a run path could send the run's writes somewhere else, so it is refused.
  for (const name of ['profile', 'library', 'out']) {
    const link = linkOnPath(resolve(options[name]));
    check(
      checks,
      `${name}-has-no-link`,
      link ? 'failed' : 'passed',
      link ? `${resolve(options[name])} goes through a link or a junction` : 'no link on the path',
    );
  }

  // The scratch library is walked for links too: a link inside it could send uploads into an owner folder. A library
  // that already sits in or holds a protected folder is refused above, so it is not walked.
  const libraryOutside = checks.some(
    (item) => item.name === 'library-outside-owner-folders' && item.status === 'failed',
  );
  const libraryLink = libraryOutside ? undefined : linkInside(resolve(options.library));
  let libraryDetail = 'no link in the library';
  if (libraryOutside)
    libraryDetail = 'not walked: the library is inside or holds a protected folder';
  else if (libraryLink !== undefined) {
    libraryDetail = `a link or an unreadable folder is in the library: ${libraryLink}`;
  }
  check(
    checks,
    'library-tree-has-no-link',
    libraryOutside || libraryLink !== undefined ? 'failed' : 'passed',
    libraryDetail,
  );

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

  // The owner library must hold no link, junction, shared file or unreadable folder. The runners refuse a run that finds
  // one, so the preflight reports it too: a link there could send a write to another folder.
  const ownerLink = linkInside(defaultLibrary);
  check(
    checks,
    'owner-library-no-link',
    ownerLink === undefined ? 'passed' : 'failed',
    ownerLink === undefined
      ? 'no link in the owner library'
      : `a link, a junction, a shared file or an unreadable folder is in the owner library: ${ownerLink}`,
  );

  // A linked owner library is not walked: the check above already fails, and a walk could read another folder.
  let ownerLibraryFiles = 0;
  if (ownerLink !== undefined) {
    check(
      checks,
      'owner-library-baseline',
      'failed',
      'not counted: the owner library holds a link',
    );
  } else if (existsSync(defaultLibrary)) {
    try {
      ownerLibraryFiles = countFiles(defaultLibrary);
      check(checks, 'owner-library-baseline', 'passed', `${ownerLibraryFiles} files counted`);
    } catch (error) {
      check(
        checks,
        'owner-library-baseline',
        'failed',
        `the owner library could not be counted: ${error.message}`,
      );
    }
  } else {
    check(checks, 'owner-library-baseline', 'passed', 'default library folder not present');
  }

  // A tool is found by an absolute path on PATH, never in the working folder, and is refused inside the installed
  // folder or the candidate's own folder. The run uses the path this check records.
  const tools = {};
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const found = findOnPath(`${tool}.exe`);
    const insideJoy =
      found !== undefined && (isInside(found, installedFolder) || isInside(found, unpackedDir));
    tools[tool] = found !== undefined && !insideJoy ? found : null;
    const probe =
      tools[tool] === null
        ? undefined
        : spawnSync(tools[tool], ['-version'], { encoding: 'utf8', timeout: 20_000 });
    const runs = probe !== undefined && probe.status === 0;
    let detail = `${tool} not found on PATH`;
    if (found !== undefined && insideJoy)
      detail = `${tool} is inside a JOY folder, so it is refused`;
    else if (found !== undefined) detail = runs ? `found at ${found}` : `${tool} did not run`;
    check(checks, `${tool}-on-path`, runs ? 'passed' : 'failed', detail);
  }

  if (process.platform !== 'win32') {
    check(checks, 'windows-host', 'failed', 'attended runs need Windows (reg.exe and tasklist)');
  } else {
    const tasks = spawnSync(
      systemTool('tasklist.exe'),
      ['/FI', 'IMAGENAME eq joy-media.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 20_000 },
    );
    // A tasklist that did not finish is not evidence that nothing is running, so the check fails.
    const listed = tasks.status === 0 && tasks.error === undefined;
    const running = listed && /joy-media\.exe/iu.test(tasks.stdout ?? '');
    let detail = 'none running';
    if (!listed) detail = 'tasklist did not finish, so no process check was made';
    else if (running) detail = 'a joy-media.exe process is running';
    check(checks, 'no-joy-media-process', listed && !running ? 'passed' : 'failed', detail);
  }

  // A run path inside an owner folder is refused before anything is written there, so a refused run
  // leaves no file behind. The key is not exported in that case.
  // Nothing is written into a run path that is inside or holds a protected folder, is inside the working folder, or
  // goes through a link.
  const blockedPath = checks.some(isPathBlock);
  if (!blockedPath) mkdirSync(resolve(options.out), { recursive: true });
  // The run folder is checked again right before anything is written into it, because a link can appear after the checks above.
  const movedRunFolder = blockedPath ? undefined : runFolderProblem(resolve(options.out));
  if (movedRunFolder !== undefined) {
    checks.push({ name: 'run-folder-has-no-link', status: 'failed', detail: movedRunFolder });
  }
  const keyFile = join(resolve(options.out), 'joy-key-before.reg');
  let joyKeyBefore = '';
  if (!blockedPath && movedRunFolder === undefined && process.platform === 'win32') {
    const exported = spawnSync(
      systemTool('reg.exe'),
      ['export', 'HKCU\\Software\\Classes\\joy', keyFile, '/y'],
      { encoding: 'utf8', timeout: 20_000 },
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
    blockedPath
      ? 'not checked: a run path is inside or holds a protected folder, or goes through a link'
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
    tools,
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
  // A preflight writes into its folder, so it refuses a folder that holds anything but its own files.
  const unexpected = unexpectedRunArtifacts(resolve(options.out));
  if (unexpected.length > 0) {
    process.stderr.write(
      `refused: ${resolve(options.out)} already holds ${unexpected.join(', ')}; a preflight needs an empty folder, so use a new run folder\n`,
    );
    process.exit(2);
  }
  const report = await runPreflight(options);
  const path = join(resolve(options.out), 'preflight.json');
  if (report.checks.some(isPathBlock)) {
    for (const item of report.checks)
      process.stdout.write(`${item.status.padEnd(7)} ${item.name}: ${item.detail}\n`);
    process.stdout.write(
      'verdict: blocked (nothing written: a run path is inside or holds a protected folder, is inside the working folder, or goes through a link)\n',
    );
    process.exit(2);
  }
  const movedNow = runFolderProblem(resolve(options.out));
  if (movedNow !== undefined) {
    process.stdout.write(`verdict: blocked (nothing written: ${movedNow})\n`);
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
