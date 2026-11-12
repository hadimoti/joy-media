#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLiveDriver } from './driver.mjs';
import { importThroughLeftPanel, newProject, screenshot, setScratchLibrary } from './steps.mjs';

const KNOWN_TESTS = new Set(['D-000', 'D-001', 'D-002']);

function parseArgs(argv) {
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
    .filter(Boolean);
  if (options.testIds.length === 0 || options.testIds.some((id) => !KNOWN_TESTS.has(id))) {
    throw new Error(`unknown test id; known tests: ${[...KNOWN_TESTS].join(', ')}`);
  }
  if (options.testIds.includes('D-002') && !options.media) {
    throw new Error('D-002 requires --media <scratch-file>');
  }
  if (options.media) {
    const root = resolve('C:\\jgp\\v111\\fixtures');
    const media = resolve(options.media);
    if (
      !media.toLowerCase().startsWith(`${root.toLowerCase()}\\`) &&
      !media.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ) {
      throw new Error('--media must be inside C:\\jgp\\v111\\fixtures');
    }
  }
  return options;
}

async function run() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`usage error: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const runId = randomUUID();
  const outDir = resolve(options.out ?? join('C:\\jgp\\v111\\evidence\\T-A02', runId));
  const scratchRoot = 'C:\\jgp\\v111\\codex';
  const profileDir = join(scratchRoot, 'profiles', runId);
  const libraryDir = join(scratchRoot, 'libraries', runId);
  const driver = createLiveDriver(
    {
      appDir: resolve(options.app),
      outDir,
      profileDir,
      libraryDir,
      runId,
      needsSignIn: options.needsSignIn,
      localAppData: options.needsSignIn ? process.env.LOCALAPPDATA : undefined,
      reason: `T-A02 live QA: ${options.testIds.join(',')}`,
    },
    options.simulateWrongJoyHash ? { preflightDeps: { joyHash: 'simulated-wrong-hash' } } : {},
  );
  const results = [];
  try {
    const session = await driver.launch();
    let setupProblem;
    try {
      await setScratchLibrary(session.page, libraryDir);
    } catch (error) {
      setupProblem = String(error?.message ?? error)
        .split('\n')[0]
        .slice(0, 400);
    }
    for (const id of options.testIds) {
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
        }
      } catch (error) {
        status = 'failed';
        message = String(error?.message ?? error)
          .split('\n')[0]
          .slice(0, 400);
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
        result.status = 'failed';
        result.message = message;
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
    if (results.some((result) => result.status !== 'passed') && process.exitCode !== 2) {
      process.exitCode = 1;
    }
  }
}

await run();
