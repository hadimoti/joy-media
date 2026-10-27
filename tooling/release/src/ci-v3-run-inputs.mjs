// Assembles the inputs ci-v3-run-summary.mjs needs from one shadow run's own outputs (plan section 3.4, D18). The shadow job calls it
// after the gate, so the comparison reads the run's real results and invents nothing. The same builder serves both topologies:
// v3 names its Vitest results in the hosted-verify report and in the Vitest JSON reports of its Windows and P0 lanes. v2 names them
// in a Vitest JSON report of the same commit.
//
//   node tooling/release/src/ci-v3-run-inputs.mjs --topology single-pass --needs <needs.json> --gate <report.json> \
//     --readiness <evidence.json> --windows <acceptance.json> --hosted <hosted-verify-report.json> \
//     --lane-vitest <lane-report.json> [--lane-vitest <lane-report.json> ...] \
//     --candidate-sha <sha> --run-attempt <n> --out <run-inputs.json>
//   node tooling/release/src/ci-v3-run-inputs.mjs --topology two-pass --needs <needs.json> --gate <report.json> \
//     --readiness <evidence.json> --windows <acceptance.json> --vitest-json <reference-vitest.json> \
//     --candidate-sha <sha> --run-attempt <n> --out <run-inputs.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANES_BY_TOPOLOGY } from './ci-v3-run-summary.mjs';
import { executedTests } from './hosted-verify.mjs';

// The 17 gate checks, as the gate names them. ci-v3-run-summary.mjs requires each one; ci-v3-run-inputs.test.ts pins this list.
export const GATE_CHECK_IDS = [
  'command-health',
  'source-provenance',
  'readiness-evidence',
  'tests',
  'generated-artifacts',
  'fixture-registries',
  'deployment-manifests',
  'builds',
  'static-assets',
  'font-assets',
  'manifest',
  'sbom',
  'browser-journey',
  'performance-evidence',
  'operational-evidence',
  'windows-acceptance',
  'feature-status',
];
const TOPOLOGIES = Object.keys(LANES_BY_TOPOLOGY);

/**
 * The Vitest results a run names: the test IDs that ran to a verdict, and the failed ones. The IDs match the equivalence
 * tool's, so a v2 reference report and a v3 report compare on the same names.
 */
export function vitestFromTests(tests) {
  const executed = tests
    .filter((test) => test.status === 'passed' || test.status === 'failed')
    .map((test) => test.id);
  const failed = tests.filter((test) => test.status === 'failed').map((test) => test.id);
  return { executed, failed };
}

/** Builds the run inputs from the run's files. Throws, naming the missing piece, when any of them is incomplete. */
export function buildRunInputs({
  topology,
  needs,
  gate,
  readiness,
  windows,
  vitest,
  candidateSha,
  attempt,
}) {
  if (!TOPOLOGIES.includes(topology)) throw new Error(`unknown topology: ${String(topology)}`);
  const laneResults = Object.fromEntries(
    LANES_BY_TOPOLOGY[topology].map((lane) => {
      const result = needs?.[lane]?.result;
      if (typeof result !== 'string')
        throw new Error(`the needs context has no result for ${lane}`);
      return [lane, result];
    }),
  );

  // release:gate writes { result: { passed, checks }, evidence }, so the verdict and the 17 checks sit under `result`.
  const releaseResult = gate?.result;
  if (!Array.isArray(releaseResult?.checks)) throw new Error('the gate report has no check list');
  const gateChecks = Object.fromEntries(
    releaseResult.checks
      .filter((check) => typeof check?.id === 'string')
      .map((check) => [check.id, check.status]),
  );
  for (const id of GATE_CHECK_IDS) {
    if (gateChecks[id] === undefined) throw new Error(`the gate report has no ${id} check`);
  }

  if (!Array.isArray(readiness?.scenarioResults)) {
    throw new Error('the readiness evidence has no scenario results');
  }
  const scenarios = Object.fromEntries(
    readiness.scenarioResults.map((scenario) => [
      scenario.id,
      {
        status: scenario.status,
        firstAttemptPassed: scenario.firstAttemptPassed,
        retries: scenario.retries,
      },
    ]),
  );

  const transitions = windows?.desktopLifecycle?.transitions;
  if (transitions === null || typeof transitions !== 'object') {
    throw new Error('the Windows acceptance evidence has no lifecycle transitions');
  }

  if (!Array.isArray(vitest?.executed) || !Array.isArray(vitest?.failed)) {
    throw new Error('the run names no verified Vitest results');
  }

  return {
    topology,
    attempt: Number(attempt),
    candidateSha,
    verdict: releaseResult.passed === true ? 'passed' : 'failed',
    gateChecks,
    scenarios,
    lifecycleTransitions: transitions,
    lanes: laneResults,
    vitest: { executed: vitest.executed, failed: vitest.failed },
  };
}

/** Reads the Vitest results of a single-pass run from its verified hosted-verify report. Refuses a report whose merge did not pass. */
export function vitestFromHostedReport(hosted) {
  if (hosted?.merge?.ok !== true || !Array.isArray(hosted?.executed)) {
    throw new Error('the hosted-verify report has no verified test list');
  }
  return vitestFromTests(hosted.executed);
}

/** Reads the Vitest results of a two-pass run from a Vitest JSON report of the same commit. Refuses a report with any failure. */
export function vitestFromReferenceReport(report) {
  if (report === null || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    throw new Error('the reference Vitest report has no test results');
  }
  if (report.numFailedTests !== 0 || !(report.numPassedTests > 0)) {
    throw new Error('the reference Vitest report did not pass every test it ran');
  }
  return vitestFromTests(executedTests(report));
}

/**
 * Reads the Vitest results one lane of a single-pass run recorded. The hosted shards do not run the Windows and P0 suites, so each
 * such lane writes its own Vitest JSON report. A lane that ran no test is refused. A failed test is recorded as failed, not hidden.
 */
export function vitestFromLaneReport(report) {
  if (report === null || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    throw new Error('the lane Vitest report has no test results');
  }
  if (!(report.numPassedTests + report.numFailedTests > 0)) {
    throw new Error('the lane Vitest report ran no test');
  }
  return vitestFromTests(executedTests(report));
}

/**
 * Reads the Vitest results of a single-pass run: the tests the hosted shards executed, and the tests each lane executed. A test that
 * more than one source names counts once, so the run names every test the equivalence tool compares.
 */
export function vitestFromSinglePass(hosted, laneReports) {
  if (laneReports.length === 0) throw new Error('the single-pass run names no lane Vitest report');
  const sources = [vitestFromHostedReport(hosted), ...laneReports.map(vitestFromLaneReport)];
  const union = (key) => [...new Set(sources.flatMap((source) => source[key]))].sort();
  return { executed: union('executed'), failed: union('failed') };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new Error(`Expected --name value pairs, got: ${key}`);
    const name = key.slice(2);
    // --lane-vitest repeats, once for each lane report. Every other option names exactly one value.
    options[name] = name === 'lane-vitest' ? [...(options[name] ?? []), value] : value;
  }
  for (const name of [
    'topology',
    'needs',
    'gate',
    'readiness',
    'windows',
    'candidate-sha',
    'run-attempt',
    'out',
  ]) {
    if (!options[name]) throw new Error(`Missing --${name}`);
  }
  if (options.topology === 'single-pass' && !options.hosted) throw new Error('Missing --hosted');
  if (options.topology === 'single-pass' && (options['lane-vitest'] ?? []).length === 0)
    throw new Error('Missing --lane-vitest');
  if (options.topology === 'two-pass' && !options['vitest-json'])
    throw new Error('Missing --vitest-json');
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function main(argv) {
  const options = parseArgs(argv);
  const vitest =
    options.topology === 'single-pass'
      ? vitestFromSinglePass(readJson(options.hosted), options['lane-vitest'].map(readJson))
      : vitestFromReferenceReport(readJson(options['vitest-json']));
  const inputs = buildRunInputs({
    topology: options.topology,
    needs: readJson(options.needs),
    gate: readJson(options.gate),
    readiness: readJson(options.readiness),
    windows: readJson(options.windows),
    vitest,
    candidateSha: options['candidate-sha'],
    attempt: options['run-attempt'],
  });
  writeFileSync(resolve(options.out), `${JSON.stringify(inputs, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `wrote ${inputs.topology} run inputs for ${inputs.candidateSha} (attempt ${inputs.attempt})\n`,
  );
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
