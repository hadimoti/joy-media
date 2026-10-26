// Repeats the Vitest suite under synthetic CPU load and records the flake signatures (plan §3.4, decision D21).
//
//   node vitest-load-repeat.mjs --runs <n> --out <dir> [--load-workers <n>]
//
// Each pass runs the whole suite once, with --retry=0, while busy-loop processes keep the CPU occupied. A pass records
// its exit code, the tests that failed, and how many times Vitest reported a timed-out "onTaskUpdate" call. The summary
// is a small JSON receipt (flake-counts.json). It is evidence about repeatability, not a release approval: the scheduled
// job that calls this script is non-blocking.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RPC_TIMEOUT = /onTaskUpdate/gu;
const SUMMARY = 'flake-counts.json';

/** Counts the "onTaskUpdate" timeout reports in a pass's console output. */
export function countRpcTimeouts(output) {
  return (output.match(RPC_TIMEOUT) ?? []).length;
}

/** Names the failed tests in a Vitest JSON report, in report order. */
export function failedTestsFromReport(report) {
  const failed = [];
  for (const file of report?.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === 'failed') failed.push(`${file.name}::${assertion.fullName}`);
    }
  }
  return failed;
}

/** Summarizes passes into the receipt. Every count is derived from the passes, never typed in. */
export function summarize(passes) {
  return {
    schemaVersion: 1,
    passes: passes.length,
    passesWithExitZero: passes.filter((pass) => pass.exitCode === 0).length,
    passesWithRpcTimeouts: passes.filter((pass) => pass.onTaskUpdateTimeouts > 0).length,
    rpcTimeoutReports: passes.reduce((total, pass) => total + pass.onTaskUpdateTimeouts, 0),
    failedTestReports: passes.reduce((total, pass) => total + pass.failedTests.length, 0),
    runs: passes,
  };
}

/** Starts `count` busy-loop processes and returns a function that stops them all. */
export function startSyntheticLoad(count, spawnFn = spawn) {
  const children = [];
  for (let index = 0; index < count; index += 1) {
    children.push(spawnFn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }));
  }
  return () => {
    for (const child of children) child.kill();
  };
}

/** Runs one Vitest pass with --retry=0 and reads its JSON report. */
export function runVitestPass(index, out, { vitestEntry, cwd }) {
  const reportFile = join(out, `pass-${index}.vitest.json`);
  const result = spawnSync(
    process.execPath,
    [vitestEntry, 'run', '--retry=0', '--reporter=json', `--outputFile=${reportFile}`],
    { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  let report = null;
  try {
    report = JSON.parse(readFileSync(reportFile, 'utf8'));
  } catch {
    report = null;
  }
  return {
    exitCode: result.status ?? 1,
    onTaskUpdateTimeouts: countRpcTimeouts(`${result.stdout ?? ''}${result.stderr ?? ''}`),
    failedTests: failedTestsFromReport(report),
    reportParsed: report !== null,
  };
}

/** Runs the passes under load, then writes the receipt. The dependencies are injectable for tests. */
export function repeatUnderLoad({ runs, out, loadWorkers, runPass, startLoad, writeSummary }) {
  mkdirSync(out, { recursive: true });
  const passes = [];
  for (let index = 1; index <= runs; index += 1) {
    const stopLoad = startLoad(loadWorkers);
    const started = Date.now();
    let result;
    try {
      result = runPass(index, out);
    } finally {
      stopLoad();
    }
    passes.push({
      pass: index,
      ...result,
      durationSeconds: Math.round((Date.now() - started) / 1000),
    });
  }
  const summary = summarize(passes);
  writeSummary(join(out, SUMMARY), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= args.length) throw new Error(`Missing value for ${name}.`);
  return args[index + 1];
}

function main(args) {
  const runs = Number(option(args, '--runs', '3'));
  if (!Number.isInteger(runs) || runs < 1 || runs > 50)
    throw new Error('--runs must be a whole number from 1 to 50.');
  const loadWorkers = Number(option(args, '--load-workers', String(availableParallelism())));
  if (!Number.isInteger(loadWorkers) || loadWorkers < 1)
    throw new Error('--load-workers must be a positive integer.');
  const outArg = option(args, '--out', null);
  if (outArg === null) throw new Error('Missing --out.');
  const out = resolve(outArg);
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const vitestEntry = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  const summary = repeatUnderLoad({
    runs,
    out,
    loadWorkers,
    runPass: (index, dir) => runVitestPass(index, dir, { vitestEntry, cwd: repoRoot }),
    startLoad: (count) => startSyntheticLoad(count),
    writeSummary: (path, text) => writeFileSync(path, text, 'utf8'),
  });
  process.stdout.write(
    `passes=${summary.passes} exitZero=${summary.passesWithExitZero} rpcTimeoutReports=${summary.rpcTimeoutReports}\n`,
  );
  const clean = summary.passesWithExitZero === summary.passes && summary.rpcTimeoutReports === 0;
  return clean ? 0 : 1;
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
