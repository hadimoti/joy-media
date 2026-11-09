#!/usr/bin/env node
// The first scripted attended scenario (restart, save and export) for one candidate build.
//
// Without --launch it runs the preflight and the refusals, then prints the plan. It copies the source
// database and its write-ahead files into plan-source only to read them, and starts nothing. With --launch
// it copies the source profile into the run folder, checks that the copy's asset library is the scratch
// library, and only then starts the candidate copy on that copy.
// Each run needs the owner at the PC and a yes that names the run.
//
// Usage (Windows, from the repository root):
//   node --experimental-strip-types tooling/release/attended/run-scenario.mjs \
//     --scenario desktop.app.restart-save-export --exe <unpacked copy>\joy-media.exe \
//     --candidate <40-hex commit> --expected-exe-sha256 <64-hex build hash> \
//     --profile-source <profile holding the project> --profile <new folder>\profile \
//     --library <scratch library with catalog.json> --out <new run folder> \
//     --project <project id> [--port 9339] [--owner-library-files <n>] [--launch]
//
// The fresh-process scenario (project.persistence.fresh-process) creates its two profiles inside the run
// folder, so it takes no source profile and no project:
//   node --experimental-strip-types tooling/release/attended/run-scenario.mjs \
//     --scenario project.persistence.fresh-process --exe <unpacked copy>\joy-media.exe \
//     --candidate <40-hex commit> --expected-exe-sha256 <64-hex build hash> \
//     --library <scratch library with catalog.json> --out <new run folder> [--media <mp4>]
//     [--owner-library-files <n>] [--launch]
// --owner-library-files approves the owner library's file count for the run; a different count is refused.
// An option the runner does not know, or one given twice, is refused, so a typo cannot drop an approval.
// Exit codes: 0 passed (or a dry run with no refusals), 2 refused, failed or not ready, 1 usage error.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  FRESH_PROCESS_SCENARIO,
  runFreshProcessPersistence,
} from '../src/attended-fresh-process.ts';
import {
  RESTART_SAVE_EXPORT,
  exportExpectation,
  runRestartSaveExport,
  stagedClipName,
} from '../src/attended-scenario.ts';
import {
  createFreshProcessDriver,
  boundedWait,
  createScenarioDriver,
  databaseModuleProblem,
} from './scenario-driver.mjs';
import {
  approvedOwnerFilesOf,
  countFiles,
  unexpectedRunArtifacts,
  isInside,
  linkInside,
  linkOnPath,
  ownerDefaultLibrary,
  ownerLibraryRefusal,
  parseRunArgs,
  reportWithFolderChanges,
  runFolderProblem,
  samePath,
} from './scenario-rules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIOS = [RESTART_SAVE_EXPORT, FRESH_PROCESS_SCENARIO];

/** The longest a scenario may take. A run that has not ended by then is recorded as an error; nothing is killed. */
const RUN_LIMIT_MS = 60 * 60_000;

/** Waits for a scenario to end, or throws when it passes the run limit. The timer stops when the scenario ends. */
async function withinRunLimit(scenario) {
  const report = await boundedWait(scenario, RUN_LIMIT_MS);
  if (report === undefined) {
    throw new Error(
      'the run did not finish within 60 minutes; the app may still be running, and the owner closes it. Nothing was killed.',
    );
  }
  return report;
}
/** The media the fresh-process scenario imports unless --media names another clip. */
const DEFAULT_CLIP = join(
  here,
  '..',
  '..',
  '..',
  'packages',
  'test-fixtures',
  'media',
  'video.mp4',
);
const DB_NAME = 'joy-media.sqlite3';
const LIBRARY_SETTING = 'asset_library_directory';
const DEFAULT_LIBRARY = ownerDefaultLibrary(homedir());
const INSTALLED_FOLDER = join(homedir(), 'AppData', 'Local', 'Programs', 'JOY Media');

/**
 * Copies a profile's database, with its write-ahead files, into a folder of the run, and returns the
 * copy's path. Reads happen on the copy, so the source profile is never opened and no sidecar files
 * can appear beside it.
 */
function copyDatabaseForReading(profileDir, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const copied = join(targetDir, DB_NAME);
  copyFileSync(join(profileDir, DB_NAME), copied);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = join(profileDir, `${DB_NAME}${suffix}`);
    if (existsSync(sidecar)) copyFileSync(sidecar, `${copied}${suffix}`);
  }
  return copied;
}

/** Reads one project row from a database copy. */
function readProject(databasePath, projectId) {
  const db = new DatabaseSync(databasePath);
  try {
    const row = db
      .prepare('SELECT revision_id, document_json FROM project_documents WHERE project_id = ?')
      .get(projectId);
    if (row === undefined) throw new Error(`project ${projectId} is not in the profile`);
    return { revisionId: row.revision_id, document: JSON.parse(row.document_json) };
  } finally {
    db.close();
  }
}

/** The asset library the profile's settings point at, or undefined when it has no such setting. */
function libraryOf(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(LIBRARY_SETTING);
    return row === undefined ? undefined : String(row.value);
  } finally {
    db.close();
  }
}

/** True when nothing is listening on the port, so the app's debug port can be opened. */
function portIsFree(port) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', () => resolvePromise(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePromise(true)));
  });
}

function printPlan(options, project, expected, library) {
  const lines = [
    `scenario: ${options.scenario}`,
    `project: ${options.project} (stored revision ${project.revisionId})`,
    `asset library: ${library} (the profile's setting matches)`,
    `save: a new revision with the title "Attended restart check <run id>", through the editor's document channel`,
    `restart: close the app, check the guards, start the same profile again, reopen the project`,
    `export: stage a ${expected.width}x${expected.height} MP4, ${expected.frameRate} fps, ${expected.frameCount} frames, ` +
      `${(expected.durationUs / 1_000_000).toFixed(3)} s (preset ${expected.preset}); render through the worker; probe the result`,
    `guards: joy:// key, JOY processes, owner library (${DEFAULT_LIBRARY}) and installed folder checked before, between and after`,
    `clip name: ${stagedClipName('<run id>')}`,
  ];
  for (const line of lines) process.stdout.write(`${line}\n`);
}

function printFreshPlan(plan) {
  const lines = [
    `scenario: ${FRESH_PROCESS_SCENARIO}`,
    `first process, new profile ${plan.sourceProfile} (asset library ${plan.library}):`,
    `  create the project FreshProcess-<run id>, import fresh-process-<run id>.mp4 (${plan.media}), add it to the timeline,`,
    '  File > Export Editable Project…; check the package and the saved state; close',
    `second process, new profile ${plan.freshProfile} (asset library ${plan.library}):`,
    '  check that it starts with no copy of the project; create FreshProcessHost-<run id>;',
    '  import the package through the import control (no native chooser); check that the imported project is the open one, its clip',
    '  and the saved state; Export MP4 and wait for the verified file; probe it with ffprobe; close',
    `guards: the joy:// key, JOY processes, the owner library (${DEFAULT_LIBRARY}) and the installed folder,`,
    '  checked before, between and after the processes; the Downloads folder is compared before and after',
    `profiles: made by the candidate's database module (${plan.databaseModule}), not copied from any profile`,
  ];
  for (const line of lines) process.stdout.write(`${line}\n`);
}

/**
 * Refuses a run before the preflight writes anything when the owner library holds a link, a junction, a shared file or
 * an unreadable folder: a link there could send a write to another folder, and a link is never followed. It also
 * checks the approved count, when one is given. The count is compared again before the first launch.
 */
function refuseOwnerLibrary(options) {
  const folder = ownerDefaultLibrary(homedir());
  // linkInside also finds a junction whose target is gone: it exists as a link even though it is not a folder.
  const link = linkInside(folder);
  if (link !== undefined) {
    process.stderr.write(
      `refused: ${link} is a link, a junction, a shared file or an unreadable folder in the owner library\nnothing was written or started\n`,
    );
    process.exit(2);
  }
  const approved = approvedOwnerFilesOf(options);
  if (approved === undefined) return;
  let actual;
  try {
    actual = existsSync(folder) ? countFiles(folder) : 0;
  } catch (error) {
    process.stderr.write(
      `refused: the owner library could not be counted: ${error.message}\nnothing was written or started\n`,
    );
    process.exit(2);
  }
  const refusal = ownerLibraryRefusal(approved, actual);
  if (refusal === null) return;
  process.stderr.write(`refused: ${refusal}\nnothing was written or started\n`);
  process.exit(2);
}

/**
 * Checks the run paths again just before anything is copied or seeded: a link may have appeared since the preflight.
 */
function refuseLinkedPaths(linkPaths, treePaths) {
  for (const path of linkPaths) {
    if (linkOnPath(path)) {
      throw new Error(
        `${path} goes through a link or a junction, so nothing was copied or started`,
      );
    }
  }
  for (const folder of treePaths) {
    const found = linkInside(folder);
    if (found !== undefined) {
      throw new Error(
        `${found} is a link, a junction, a shared file or an unreadable folder, so nothing was copied or started`,
      );
    }
  }
}

/**
 * Refuses before a write into the run folder when a link, a junction, a shared file or an unreadable folder is in it now.
 * The preflight checked the run folder earlier, and a link can appear after that check.
 */
function refuseLinkedRunFolder(out) {
  const problem = runFolderProblem(out);
  if (problem !== undefined) {
    process.stderr.write(`refused: ${problem}\nno further file was written to the run folder\n`);
    process.exit(2);
  }
}

/**
 * The fresh-process scenario from the command line: the preflight and the refusals, then the plan, and
 * with --launch the two processes. It never copies a profile and never opens the owner's data.
 */
async function runFreshProcess(options) {
  const out = resolve(options.out);
  const library = resolve(options.library);
  const exe = resolve(options.exe);
  const port = Number(options.port ?? 9339);
  const media = resolve(options.media ?? DEFAULT_CLIP);
  const sourceProfile = join(out, 'profile-source');
  const freshProfile = join(out, 'profile-fresh');
  const refusals = [];

  // The installed app is never run by a scenario, so this is refused before anything else is read.
  if (isInside(exe, INSTALLED_FOLDER)) {
    process.stderr.write(
      'refused: the exe is inside the installed JOY Media folder; the run uses the candidate copy only. Nothing was checked, created or started.\n',
    );
    process.exit(2);
  }

  // A run writes into its folder only when the folder holds nothing but the preflight's own files.
  const unexpected = unexpectedRunArtifacts(out);
  if (unexpected.length > 0) {
    process.stderr.write(
      `refused: ${out} already holds ${unexpected.join(', ')}; a run needs an empty folder, so use a new run folder\n`,
    );
    process.exit(2);
  }

  refuseOwnerLibrary(options);

  // The preflight checks the owner's folders, the joy:// key, the app and the tools. It is given the
  // fresh profile as its profile; the source profile is checked below, because it must not exist either.
  const preflight = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      join(here, 'attended-preflight.mjs'),
      '--exe',
      exe,
      '--candidate',
      options.candidate,
      '--profile',
      freshProfile,
      '--library',
      library,
      '--out',
      out,
    ],
    { encoding: 'utf8', timeout: 300_000 },
  );
  process.stdout.write(preflight.stdout ?? '');
  process.stderr.write(preflight.stderr ?? '');
  if (preflight.status !== 0) {
    process.stderr.write('not ready: the preflight blocked the run, so nothing was started\n');
    process.exit(2);
  }
  const preflightReport = JSON.parse(readFileSync(join(out, 'preflight.json'), 'utf8'));
  if (preflightReport.exe.sha256 !== options['expected-exe-sha256']) {
    refusals.push(
      `the exe hash ${preflightReport.exe.sha256} is not the expected build hash ${options['expected-exe-sha256']}`,
    );
  }
  if (existsSync(sourceProfile)) {
    refusals.push(`${sourceProfile} already exists; a run needs new profile folders`);
  }
  if (!existsSync(media)) refusals.push(`the clip ${media} does not exist`);
  if (!(await portIsFree(port))) {
    refusals.push(`port ${port} is in use; the app's debug port must be free`);
  }
  if (refusals.length > 0) {
    for (const refusal of refusals) process.stderr.write(`refused: ${refusal}\n`);
    process.stderr.write('nothing was started\n');
    process.exit(2);
  }

  if (!options.launch) {
    printFreshPlan({
      library,
      media,
      sourceProfile,
      freshProfile,
      databaseModule: join(
        preflightReport.unpackedDir,
        'resources',
        'app',
        'dist',
        'store',
        'local-database.js',
      ),
    });
    process.stdout.write(
      'dry run: no refusals; no profile was created and nothing was started. The preflight wrote only its own files. Repeat with --launch after the owner says yes.\n',
    );
    process.exit(0);
  }

  // The candidate's database module runs only here, once the owner has asked for a launch. A dry run runs none of it.
  const moduleProblem = await databaseModuleProblem(preflightReport.unpackedDir);
  if (moduleProblem !== null) {
    process.stderr.write(`refused: ${moduleProblem}\nnothing was started\n`);
    process.exit(2);
  }

  // From here on, anything that goes wrong is written to error.json, so the run never fails silently.
  const runId = randomUUID();
  let report;
  try {
    process.stdout.write(
      'launching the candidate copy in two new profiles; the owner must be at the PC\n',
    );
    const driver = createFreshProcessDriver({
      exe,
      unpackedDir: preflightReport.unpackedDir,
      runDir: out,
      port,
      defaultLibrary: DEFAULT_LIBRARY,
      installedFolder: INSTALLED_FOLDER,
      downloadsFolder: join(homedir(), 'Downloads'),
      clipFixture: media,
      ffmpeg: preflightReport.tools.ffmpeg,
      ffprobe: preflightReport.tools.ffprobe,
    });
    const libraryBefore = await driver.ownerLibrarySignature();
    refuseLinkedPaths([out, library], [out, library, DEFAULT_LIBRARY]);
    report = await withinRunLimit(
      runFreshProcessPersistence(driver, {
        approvedOwnerFiles: approvedOwnerFilesOf(options),
        runId,
        candidateSha: preflightReport.candidateSha,
        exeSha256: preflightReport.exe.sha256,
        unpackedDir: preflightReport.unpackedDir,
        library,
        sourceProfile,
        freshProfile,
      }),
    );
    // The owner library is compared with its reading from before the run. A change is a blocker, as in the restart runner.
    report = reportWithFolderChanges(report, [
      {
        label: 'the owner library',
        before: libraryBefore,
        after: await driver.ownerLibrarySignature(),
      },
    ]);
  } catch (error) {
    const errorPath = join(out, 'error.json');
    if (runFolderProblem(out) === undefined) {
      writeFileSync(
        errorPath,
        `${JSON.stringify({ runId, error: String(error?.stack ?? error) }, null, 2)}\n`,
        'utf8',
      );
      process.stderr.write(`error: the run stopped (${errorPath}): ${error?.message ?? error}\n`);
    } else {
      process.stderr.write(
        `error: the run stopped: ${error?.message ?? error}; no file was written to the run folder, which has a link\n`,
      );
    }
    process.exit(2);
  }

  refuseLinkedRunFolder(out);
  writeFileSync(
    join(out, 'run.json'),
    `${JSON.stringify({ ...report, approvedOwnerFiles: approvedOwnerFilesOf(options) }, null, 2)}\n`,
    'utf8',
  );
  if (report.receipt !== undefined) {
    writeFileSync(
      join(out, 'receipt.json'),
      `${JSON.stringify(report.receipt, null, 2)}\n`,
      'utf8',
    );
  }
  process.stdout.write(`verdict: ${report.verdict} (${join(out, 'run.json')})\n`);
  for (const check of report.checks) {
    process.stdout.write(`${check.status.padEnd(8)} ${check.name}: ${check.detail}\n`);
  }
  for (const blocker of report.blockers) process.stdout.write(`blocker: ${blocker}\n`);
  process.exit(report.verdict === 'passed' ? 0 : 2);
}

async function main() {
  let options;
  try {
    options = parseRunArgs(process.argv.slice(2), SCENARIOS);
  } catch (error) {
    process.stderr.write(`usage error: ${error.message}\n`);
    process.exit(1);
  }

  if (options.scenario === FRESH_PROCESS_SCENARIO) {
    await runFreshProcess(options);
    return;
  }

  const out = resolve(options.out);
  const profile = resolve(options.profile);
  const profileSource = resolve(options['profile-source']);
  const exe = resolve(options.exe);
  const library = resolve(options.library);
  const port = Number(options.port ?? 9339);
  const refusals = [];

  // The installed app is never run by a scenario, so this is refused before anything else is read.
  if (isInside(exe, INSTALLED_FOLDER)) {
    process.stderr.write(
      'refused: the exe is inside the installed JOY Media folder; the run uses the candidate copy only. Nothing was checked, copied or started.\n',
    );
    process.exit(2);
  }
  // A run writes into its folder only when the folder holds nothing but the preflight's own files.
  const unexpected = unexpectedRunArtifacts(out);
  if (unexpected.length > 0) {
    process.stderr.write(
      `refused: ${out} already holds ${unexpected.join(', ')}; a run needs an empty folder, so use a new run folder\n`,
    );
    process.exit(2);
  }
  // A copy of the source profile follows its links, so a link anywhere in the tree refuses the run before anything runs.
  const profileLink = linkInside(profileSource);
  if (profileLink !== undefined) {
    process.stderr.write(
      `refused: the source profile holds a link, a junction, a shared file or an unreadable folder: ${profileLink}\nnothing was copied or started\n`,
    );
    process.exit(2);
  }

  refuseOwnerLibrary(options);

  const preflight = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      join(here, 'attended-preflight.mjs'),
      '--exe',
      exe,
      '--candidate',
      options.candidate,
      '--profile',
      profile,
      '--library',
      library,
      '--out',
      out,
    ],
    { encoding: 'utf8', timeout: 300_000 },
  );
  process.stdout.write(preflight.stdout ?? '');
  process.stderr.write(preflight.stderr ?? '');
  if (preflight.status !== 0) {
    process.stderr.write(
      'not ready: the preflight blocked the run, so nothing was copied or started\n',
    );
    process.exit(2);
  }
  const preflightReport = JSON.parse(readFileSync(join(out, 'preflight.json'), 'utf8'));
  if (preflightReport.exe.sha256 !== options['expected-exe-sha256']) {
    refusals.push(
      `the exe hash ${preflightReport.exe.sha256} is not the expected build hash ${options['expected-exe-sha256']}`,
    );
  }

  refuseLinkedRunFolder(out);
  let project;
  let expected;
  let profileLibrary;
  try {
    const planDatabase = copyDatabaseForReading(profileSource, join(out, 'plan-source'));
    project = readProject(planDatabase, options.project);
    expected = exportExpectation(project.document);
    profileLibrary = libraryOf(planDatabase);
  } catch (error) {
    process.stderr.write(`not ready: the source profile could not be read: ${error.message}\n`);
    process.exit(2);
  }
  if (profileLibrary === undefined || !samePath(profileLibrary, library)) {
    refusals.push(
      `the profile's asset library is ${profileLibrary ?? 'not set'}, not ${library}; the upload would write there`,
    );
  }
  if (!(await portIsFree(port))) {
    refusals.push(`port ${port} is in use; the app's debug port must be free`);
  }

  if (refusals.length > 0) {
    for (const refusal of refusals) process.stderr.write(`refused: ${refusal}\n`);
    process.stderr.write(
      'nothing was started; the source database was copied only into plan-source, for reading\n',
    );
    process.exit(2);
  }

  if (!options.launch) {
    printPlan(options, project, expected, library);
    process.stdout.write(
      'dry run: no refusals; nothing was started; the source database was copied only into plan-source, for reading. Repeat with --launch after the owner says yes.\n',
    );
    process.exit(0);
  }

  // From here on, anything that goes wrong is written to error.json, so the run never fails silently.
  const runId = randomUUID();
  let report;
  try {
    process.stdout.write(
      `launching the candidate copy on a copy of the profile (${profile}); the owner must be at the PC\n`,
    );
    refuseLinkedPaths([profile, out, library], [out, profileSource, library, DEFAULT_LIBRARY]);
    cpSync(profileSource, profile, { recursive: true, errorOnExist: true, force: false });
    const copiedLibrary = libraryOf(join(profile, DB_NAME));
    if (copiedLibrary === undefined || !samePath(copiedLibrary, library)) {
      throw new Error(
        `the copied profile's asset library is ${copiedLibrary ?? 'not set'}, not ${library}; nothing was started`,
      );
    }
    const driver = createScenarioDriver({
      exe,
      unpackedDir: preflightReport.unpackedDir,
      profile,
      runDir: out,
      port,
      defaultLibrary: DEFAULT_LIBRARY,
      installedFolder: INSTALLED_FOLDER,
      downloadsFolder: join(homedir(), 'Downloads'),
      ffmpeg: preflightReport.tools.ffmpeg,
      ffprobe: preflightReport.tools.ffprobe,
    });
    const downloadsBefore = await driver.downloadsSignature();
    const libraryBefore = await driver.ownerLibrarySignature();
    report = await withinRunLimit(
      runRestartSaveExport(driver, {
        approvedOwnerFiles: approvedOwnerFilesOf(options),
        runId,
        candidateSha: preflightReport.candidateSha,
        projectId: options.project,
        exeSha256: preflightReport.exe.sha256,
        unpackedDir: preflightReport.unpackedDir,
      }),
    );
    // The owner library and the Downloads folder are compared with their readings from before the run. A change is
    // recorded as a blocker and no receipt is written, so the run's evidence is kept.
    report = reportWithFolderChanges(report, [
      {
        label: 'the owner library',
        before: libraryBefore,
        after: await driver.ownerLibrarySignature(),
      },
      {
        label: 'the Downloads folder',
        before: downloadsBefore,
        after: await driver.downloadsSignature(),
      },
    ]);
  } catch (error) {
    const errorPath = join(out, 'error.json');
    if (runFolderProblem(out) === undefined) {
      writeFileSync(
        errorPath,
        `${JSON.stringify({ runId, error: String(error?.stack ?? error) }, null, 2)}\n`,
        'utf8',
      );
      process.stderr.write(`error: the run stopped (${errorPath}): ${error?.message ?? error}\n`);
    } else {
      process.stderr.write(
        `error: the run stopped: ${error?.message ?? error}; no file was written to the run folder, which has a link\n`,
      );
    }
    process.exit(2);
  }

  refuseLinkedRunFolder(out);
  writeFileSync(
    join(out, 'run.json'),
    `${JSON.stringify({ ...report, approvedOwnerFiles: approvedOwnerFilesOf(options) }, null, 2)}\n`,
    'utf8',
  );
  if (report.receipt !== undefined) {
    writeFileSync(
      join(out, 'receipt.json'),
      `${JSON.stringify(report.receipt, null, 2)}\n`,
      'utf8',
    );
  }
  process.stdout.write(`verdict: ${report.verdict} (${join(out, 'run.json')})\n`);
  for (const check of report.checks) {
    process.stdout.write(`${check.status.padEnd(8)} ${check.name}: ${check.detail}\n`);
  }
  for (const blocker of report.blockers) process.stdout.write(`blocker: ${blocker}\n`);
  process.exit(report.verdict === 'passed' ? 0 : 2);
}

await main();
