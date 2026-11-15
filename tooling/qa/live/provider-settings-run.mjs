#!/usr/bin/env node
/**
 * T-A11 runner: starts the local stub model, runs the provider-settings cases of
 * `provider-settings-steps.mjs` in the app (or on the fake page with --dry-run), and writes the
 * results, the stub request log and the captured IPC replies for the key grep.
 *
 *   node tooling/qa/live/provider-settings-run.mjs --app <unpacked-dir> [--tests D-087,D-088]
 *     [--out <dir>] [--plan-operations <json file>] [--needs-sign-in]
 *   node tooling/qa/live/provider-settings-run.mjs --dry-run
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveDriver } from './driver.mjs';
import { newProject, screenshot, setScratchLibrary } from './steps.mjs';
import { createFakePage } from './provider-settings-fake-page.mjs';
import {
  collectIpc,
  installIpcCapture,
  PROVIDER_SETTINGS_CASES,
  PROVIDER_SETTINGS_ORDER,
  scanEvidenceForSecret,
} from './provider-settings-steps.mjs';
import { buildSettingsFlowScript } from '../stub-model/settings-flow-script.mjs';

const SERVER_PATH = fileURLToPath(new URL('../stub-model/server.mjs', import.meta.url));
const SCRATCH_ROOT = 'C:\\jgp\\v111\\codex';

function parseArgs(argv) {
  const options = { dryRun: false, needsSignIn: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--needs-sign-in') options.needsSignIn = true;
    else if (['--app', '--tests', '--out', '--plan-operations'].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      options[arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.dryRun && !options.app) {
    throw new Error(
      'usage: provider-settings-run.mjs --app <unpacked-dir> [--tests ..] | --dry-run',
    );
  }
  options.testIds = options.tests
    ? options.tests
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    : [...PROVIDER_SETTINGS_ORDER];
  const unknown = options.testIds.filter((id) => !(id in PROVIDER_SETTINGS_CASES));
  if (unknown.length > 0) {
    throw new Error(
      `unknown test id ${unknown.join(',')}; known: ${PROVIDER_SETTINGS_ORDER.join(',')}`,
    );
  }
  return options;
}

/** Starts the stub on an ephemeral loopback port; resolves with its base URL and a stop function. */
function startStub({ scriptPath, logPath }) {
  return new Promise((resolveStub, reject) => {
    const child = spawn(
      process.execPath,
      [SERVER_PATH, '--port', '0', '--script', scriptPath, '--log', logPath],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`the stub exited early with code ${code}`)));
    child.stdout.setEncoding('utf8');
    child.stdout.once('data', (chunk) => {
      const ready = JSON.parse(chunk.split('\n')[0]);
      child.removeAllListeners('exit');
      resolveStub({
        baseUrl: ready.baseUrl,
        model: ready.model,
        async stop() {
          await globalThis
            .fetch(`${new URL(ready.baseUrl).origin}/__shutdown`, { method: 'POST' })
            .catch(() => undefined);
          child.kill();
        },
      });
    });
  });
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
  const outDir = resolve(options.out ?? join('C:\\jgp\\v111\\evidence\\T-A11', runId));
  mkdirSync(outDir, { recursive: true });
  const scriptPath = join(outDir, 'stub-script.json');
  const logPath = join(outDir, 'stub-requests.ndjson');
  // The key is typed into the app and must appear nowhere in the evidence or IPC replies.
  const apiKey = `joy-stub-key-${randomUUID()}`;
  const keyDir = join(SCRATCH_ROOT, 'keys');
  mkdirSync(keyDir, { recursive: true });
  const keyFile = join(keyDir, `${runId}.txt`);
  writeFileSync(keyFile, `${apiKey}\n`, 'utf8');

  const planOperations = options.planOperations
    ? JSON.parse(readFileSync(resolve(options.planOperations), 'utf8'))
    : undefined;
  writeFileSync(
    scriptPath,
    `${JSON.stringify(buildSettingsFlowScript(planOperations ? { planOperations } : {}), null, 2)}\n`,
    'utf8',
  );
  const stub = await startStub({ scriptPath, logPath });
  const ctx = { baseUrl: stub.baseUrl, model: stub.model, apiKey };
  const results = [];
  let driver;
  let page;
  let ipcMode = 'not-installed';
  const profileDir = join(SCRATCH_ROOT, 'profiles', runId);
  try {
    if (options.dryRun) {
      page = createFakePage();
      ctx.timeoutMs = 300;
    } else {
      driver = createLiveDriver({
        appDir: resolve(options.app),
        outDir,
        profileDir,
        libraryDir: join(SCRATCH_ROOT, 'libraries', runId),
        runId,
        needsSignIn: options.needsSignIn,
        localAppData: options.needsSignIn ? process.env.LOCALAPPDATA : undefined,
        reason: `T-A11 live QA: ${options.testIds.join(',')}`,
      });
      const session = await driver.launch();
      page = session.page;
      await setScratchLibrary(page, join(SCRATCH_ROOT, 'libraries', runId));
      await newProject(page, `T-A11 ${runId.slice(0, 8)}`);
      ipcMode = await installIpcCapture(page).catch(() => 'failed');
    }
    for (const id of options.testIds) {
      const startedAt = Date.now();
      let status = 'passed';
      let detail;
      try {
        detail = await PROVIDER_SETTINGS_CASES[id](page, ctx);
      } catch (error) {
        status = 'failed';
        detail = String(error?.message ?? error)
          .split('\n')[0]
          .slice(0, 400);
      }
      const shot = options.dryRun
        ? null
        : await screenshot(page, join(outDir, id, 'screenshot.png')).catch(() => null);
      // A case may return data (D-090 returns one entry per mode) beside its one-line message.
      const data = typeof detail === 'object' && detail !== null ? detail : undefined;
      if (data) detail = data.message;
      results.push({
        id,
        status,
        detail,
        ...(data ? { data } : {}),
        screenshot: shot,
        ms: Date.now() - startedAt,
      });
      mkdirSync(join(outDir, id), { recursive: true });
      writeFileSync(
        join(outDir, id, 'result.json'),
        `${JSON.stringify(results.at(-1), null, 2)}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`refused: ${String(error?.message ?? error).split('\n')[0]}\n`);
    process.exitCode = error?.code === 'LIVE_PREFLIGHT_REFUSED' ? 2 : 1;
  } finally {
    const ipc = page && !options.dryRun ? await collectIpc(page).catch(() => []) : [];
    writeFileSync(join(outDir, 'ipc-replies.ndjson'), ipc.join('\n') + (ipc.length ? '\n' : ''));
    await stub.stop();
    if (driver) {
      try {
        await driver.close();
      } catch (error) {
        process.stderr.write(`post-run safety check failed: ${String(error?.message ?? error)}\n`);
        process.exitCode = 2;
      }
    }
    let secretCheck = 'pending evidence scan';
    const summaryPath = join(outDir, 'summary.json');
    const writeSummary = () =>
      writeFileSync(
        summaryPath,
        `${JSON.stringify({ runId, ipcMode, secretCheck, keyFile, results }, null, 2)}\n`,
      );
    try {
      writeSummary();
      const scan = await scanEvidenceForSecret(apiKey, outDir);
      secretCheck = `checked ${scan.filesScanned} text evidence files (screenshots excluded): no key`;
      writeSummary();
      const finalScan = await scanEvidenceForSecret(apiKey, outDir);
      secretCheck = `checked ${finalScan.filesScanned} text evidence files (screenshots excluded): no key`;
      writeSummary();
    } catch (error) {
      secretCheck = `FAILED: ${error.message}`;
      process.exitCode = 1;
      writeSummary();
      await scanEvidenceForSecret(apiKey, outDir).catch(() => undefined);
    }
    for (const result of results) {
      process.stdout.write(`${result.id}: ${result.status} ${result.detail ?? ''}\n`);
    }
    process.stdout.write(`ipc capture: ${ipcMode}; ${secretCheck}\nevidence: ${outDir}\n`);
    if (results.some((result) => result.status !== 'passed')) process.exitCode ||= 1;
  }
}

await run();
