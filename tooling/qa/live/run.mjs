#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createLiveDriver } from './driver.mjs';
import { labRoots } from './lab-roots.mjs';
import {
  addToTimelineThroughLeftPanel,
  importThroughLeftPanel,
  newProject,
  screenshot,
  setScratchLibrary,
} from './steps.mjs';
import {
  MONITOR_MEDIA_IDS,
  MONITOR_SUITE_CASES,
  MONITOR_SUITE_IDS,
  zoomShots,
} from './monitor-suite-steps.mjs';
import { LIVE_ROWS } from './matrix.mjs';
import { runRows } from './rows.mjs';

import { MATRIX_IDS, MATRIX_ROWS, createMatrixContext } from './desktop-matrix-rows.mjs';
import { executeRow } from './matrix-core.mjs';

const LAB = labRoots();

const KNOWN_TESTS = new Set([
  'D-000',
  'D-001',
  'D-002',
  ...MONITOR_SUITE_IDS,
  ...LIVE_ROWS.map((row) => row.id),
  ...MATRIX_IDS,
]);

// `D-M*` expands to every known id with that prefix (T-M13 suite).
function expandPrefix(prefix) {
  return [...KNOWN_TESTS].filter((id) => id.startsWith(prefix));
}

export function parseArgs(argv) {
  const options = { needsSignIn: false, simulateWrongJoyHash: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--needs-sign-in') {
      options.needsSignIn = true;
      continue;
    }
    if (arg === '--simulate-wrong-joy-hash') {
      options.simulateWrongJoyHash = true;
      continue;
    }
    if (!['--tests', '--app', '--out', '--media'].includes(arg)) {
      throw new Error(`unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
    options[arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  if (!options.tests || !options.app) {
    throw new Error(
      [
        'usage: run.mjs --tests D-000,D-001 --app <unpacked-dir>',
        '[--out <dir>] [--media <scratch-file>] [--needs-sign-in]',
        '[--simulate-wrong-joy-hash]',
      ].join(' '),
    );
  }
  options.testIds = options.tests
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .flatMap((id) => (id.endsWith('*') ? expandPrefix(id.slice(0, -1)) : [id]));
  if (options.testIds.length === 0 || options.testIds.some((id) => !KNOWN_TESTS.has(id))) {
    throw new Error(`unknown test id; known tests: ${[...KNOWN_TESTS].join(', ')}`);
  }
  if (options.testIds.includes('D-002') && !options.media) {
    throw new Error('D-002 requires --media <scratch-file>');
  }
  if (options.media) {
    const root = resolve(LAB.fixtures);
    const media = resolve(options.media);
    if (
      !media.toLowerCase().startsWith(`${root.toLowerCase()}\\`) &&
      !media.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ) {
      throw new Error(`--media must be inside ${LAB.fixtures}`);
    }
  }
  return options;
}

export async function run(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`usage error: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const runId = randomUUID();
  const testMode = options.testIds.some((id) => LIVE_ROWS.some((row) => row.id === id));
  const evidenceTask = testMode ? 'T-A07-A08' : 'T-A02';
  const outDir = resolve(options.out ?? join(LAB.evidence, evidenceTask, runId));
  const scratchRoot = LAB.scratch;
  const profileDir = join(scratchRoot, 'profiles', runId);
  const libraryDir = join(scratchRoot, 'libraries', runId);
  const projectTitle = `T-A07/A08 ${runId.slice(0, 8)}`;
  const driverConfig = {
    appDir: resolve(options.app),
    outDir,
    profileDir,
    libraryDir,
    downloadDir: join(profileDir, 'downloads'),
    testMode,
    runId,
    needsSignIn: options.needsSignIn,
    localAppData: options.needsSignIn ? process.env.LOCALAPPDATA : undefined,
    reason: `${evidenceTask} live QA: ${options.testIds.join(',')}`,
  };
  const driverOptions = options.simulateWrongJoyHash
    ? { preflightDeps: { joyHash: 'simulated-wrong-hash' } }
    : {};
  const makeDriver = (reuseExisting = false) =>
    createLiveDriver({ ...driverConfig, reuseExisting }, driverOptions);
  let driver = makeDriver();
  const results = [];
  try {
    let session = await driver.launch();
    let setupProblem;
    try {
      await setScratchLibrary(session.page, libraryDir);
    } catch (error) {
      setupProblem = String(error?.message ?? error)
        .split('\n')[0]
        .slice(0, 400);
    }
    if (!setupProblem && (options.testIds.some((id) => id in MONITOR_SUITE_CASES) || testMode)) {
      try {
        await newProject(session.page, testMode ? projectTitle : `T-M13 ${runId.slice(0, 8)}`);
      } catch (error) {
        setupProblem = String(error?.message ?? error)
          .split('\n')[0]
          .slice(0, 400);
      }
    }
    if (!setupProblem && testMode && options.media) {
      try {
        await importThroughLeftPanel(session.page, options.media);
        await addToTimelineThroughLeftPanel(session.page, options.media);
      } catch (error) {
        setupProblem = String(error?.message ?? error)
          .split('\n')[0]
          .slice(0, 400);
      }
    }
    const taskRows = LIVE_ROWS.filter((row) => options.testIds.includes(row.id));
    const taskContext = {
      page: session.page,
      outDir,
      downloadDir: session.downloadDir,
      media: options.media,
      libraryDir,
      projectTitle,
      shot: async (path) => screenshot(taskContext.page, path),
      restartApp: async () => {
        await driver.close();
        driver = makeDriver(true);
        session = await driver.launch();
        taskContext.page = session.page;
        taskContext.downloadDir = session.downloadDir;
      },
    };
    if (taskRows.length > 0) {
      const runnableRows = setupProblem
        ? taskRows.map((row) => ({
            ...row,
            run: async () => {
              throw new Error(setupProblem);
            },
          }))
        : taskRows;
      results.push(...(await runRows(runnableRows, taskContext)).map(({ result }) => result));
    }
    let mediaImported = false;
    // T-A05 and T-A06 rows (desktop-matrix-rows.mjs) build their own result, evidence and defect text.
    const matrixContext = options.testIds.some((id) => id in MATRIX_ROWS)
      ? createMatrixContext({ page: session.page, outDir, libraryDir, runId })
      : undefined;
    if (matrixContext && !setupProblem) await matrixContext.bridge.installTap().catch(() => false);
    for (const id of options.testIds) {
      if (LIVE_ROWS.some((row) => row.id === id)) continue;
      if (id in MATRIX_ROWS) {
        results.push(
          setupProblem
            ? { id, status: 'failed', message: setupProblem, screenshot: null, ms: 0, evidence: [] }
            : await executeRow(MATRIX_ROWS[id], session.page, matrixContext),
        );
        continue;
      }
      const startedAt = Date.now();
      let message = setupProblem ?? '';
      let status = setupProblem ? 'failed' : 'passed';
      const shotPath = join(outDir, id, 'screenshot.png');
      try {
        if (setupProblem) throw new Error(setupProblem);
        if (id === 'D-000') {
          const title = await driver.title();
          if (!title.trim()) throw new Error('app window title was empty');
          message = `window opened; title read: ${title}`;
        } else if (id === 'D-001') {
          const title = `T-A02 ${runId.slice(0, 8)}`;
          await newProject(session.page, title);
          message = `created project: ${title}`;
        } else if (id === 'D-002') {
          await importThroughLeftPanel(session.page, options.media);
          message = `imported ${options.media.split(/[\\/]/u).at(-1)} through the Media panel`;
        } else if (id in MONITOR_SUITE_CASES) {
          if (MONITOR_MEDIA_IDS.has(id)) {
            if (!options.media)
              throw new Error(
                `BLOCKED-on-fixture ${id}: needs --media <file in the fixtures folder>; run.mjs imports it and adds it to the timeline first, because Play is disabled on an empty timeline`,
              );
            if (!mediaImported) {
              await importThroughLeftPanel(session.page, options.media);
              await addToTimelineThroughLeftPanel(session.page, options.media);
              mediaImported = true;
            }
          }
          const caseDir = join(outDir, id);
          await zoomShots(session.page, caseDir, 'before');
          try {
            message = await MONITOR_SUITE_CASES[id](session.page, {});
          } finally {
            await zoomShots(session.page, caseDir, 'after').catch(() => null);
          }
        }
      } catch (error) {
        message = String(error?.message ?? error)
          .split('\n')[0]
          .slice(0, 400);
        status = /^BLOCKED/u.test(message) ? 'blocked' : 'failed';
      }
      const screenshotPath = await screenshot(session.page, shotPath).catch(() => null);
      results.push({ id, status, message, screenshot: screenshotPath, ms: Date.now() - startedAt });
    }
  } catch (error) {
    process.stderr.write(`refused: ${String(error?.message ?? error).split('\n')[0]}\n`);
    process.exitCode = error?.code === 'LIVE_PREFLIGHT_REFUSED' ? 2 : 1;
  } finally {
    try {
      await driver.close();
    } catch (error) {
      const message = `post-run safety check failed: ${
        String(error?.message ?? error).split('\n')[0]
      }`;
      for (const result of results) {
        // Keep what the row found: the safety failure is added, it does not erase the row's own result.
        result.message = `${message}; row result before the check: ${result.status}, ${result.message}`;
        result.status = 'failed';
      }
      process.exitCode = 2;
    }
  }

  if (results.length > 0) {
    for (const result of results) {
      const resultDir = join(outDir, result.id);
      mkdirSync(resultDir, { recursive: true });
      writeFileSync(join(resultDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      process.stdout.write(`${result.id}: ${result.status} ${result.message}\n`);
    }
    // A "not-reachable" row is a finding for CC to judge, not a failed run.
    const failedRun = results.some(
      (result) => result.status !== 'passed' && result.status !== 'not-reachable',
    );
    if (failedRun && process.exitCode !== 2) {
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run();
}
