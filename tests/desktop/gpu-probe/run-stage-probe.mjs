/* Runs the GPU stage probe, one fresh Electron process per stage (L2, plan section 3.2, step 2). Attended G1 tool: a stage
 * can crash the GPU process on this PC, so it runs only with the owner present. It starts the Electron binary that
 * apps/desktop installs and never touches the installed app or the app's source. */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const desktopDir = join(repoRoot, 'apps', 'desktop');
const probeMain = join(here, 'probe-main.cjs');
const probeStages = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'];

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const outOption = option('out', '');
if (!outOption) {
  throw new Error(
    'usage: run-stage-probe.mjs --out <folder outside the repository> [--stages S0,S1] [--timeout-seconds 120]',
  );
}
const outDir = resolve(outOption);
if (outDir === repoRoot || outDir.startsWith(repoRoot + sep)) {
  throw new Error('--out must be outside the repository; raw GPU results stay on this PC.');
}
const stages = option('stages', probeStages.join(','))
  .split(',')
  .map((stage) => stage.trim())
  .filter(Boolean);
for (const stage of stages) {
  if (!probeStages.includes(stage)) {
    throw new Error(
      `unknown or unsupported stage: ${stage} (S7 runs through run-default-export-repeat.ps1)`,
    );
  }
}
const timeoutMs = Number(option('timeout-seconds', '120')) * 1000;
const electronBinary = createRequire(join(desktopDir, 'package.json'))('electron');

function runStage(stage, resultPath) {
  return new Promise((resolveRun) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronBinary, [probeMain, `--stage=${stage}`, `--out=${resultPath}`], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => output.push(chunk));
    const timer = setTimeout(() => {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    }, timeoutMs);
    child.on('close', async (exitCode, signal) => {
      clearTimeout(timer);
      await writeFile(join(outDir, `${stage}.log`), Buffer.concat(output));
      resolveRun({ exitCode, signal });
    });
  });
}

async function readResult(resultPath, stage, exit) {
  try {
    return JSON.parse(await readFile(resultPath, 'utf8'));
  } catch {
    return {
      stage,
      ok: false,
      error: 'no result file',
      exitCode: exit.exitCode,
      signal: exit.signal,
    };
  }
}

await mkdir(outDir, { recursive: true });
const summary = [];
for (const stage of stages) {
  const resultPath = join(outDir, `${stage}.json`);
  const exit = await runStage(stage, resultPath);
  const result = await readResult(resultPath, stage, exit);
  summary.push({
    stage,
    ok: result.ok === true,
    crashed: result.crashed ?? null,
    exitCode: exit.exitCode,
    childProcessGone: (result.childProcessGone ?? []).length,
    error: result.error ?? null,
  });
  console.log(
    `${stage} ok=${result.ok === true} crashed=${result.crashed ?? '-'} exit=${exit.exitCode} error=${result.error ?? '-'}`,
  );
}
const summaryPath = join(outDir, 'summary.json');
await writeFile(summaryPath, JSON.stringify({ electronBinary, stages: summary }, null, 2), 'utf8');
console.log(`summary: ${summaryPath}`);
