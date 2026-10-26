// Writes the summary one shadow run leaves for the comparison (plan section 3.4, D18). The shadow job gathers the inputs from its gate
// and job results, and this module checks them and writes ci-v3-shadow-compare.mjs's input. It invents nothing: a missing check, lane,
// scenario, transition or Vitest list fails the write, so the comparison never compares a summary that is only partly known.
//
//   node tooling/release/src/ci-v3-run-summary.mjs --input <run-inputs.json> --out <run-summary.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The same lists ci-v3-shadow-compare.mjs compares against. ci-v3-run-summary.test.ts fails if they drift apart.
export const GATE_CHECKS = [
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
// The lanes of each topology, as the gate's needs list names them. The two-pass lanes are release-candidate-v2's nine lanes; the
// single-pass lanes are release-candidate-v3's eight (plan section 3.4). ci-v3-run-summary.test.ts pins both against the gate.
export const TWO_PASS_LANES = [
  'linux-real-services',
  'windows-p0-real-services',
  'node-contracts',
  'windows-worker-clean',
  'acceptance-primary',
  'acceptance-responsive',
  'prod-build-smoke',
  'real-service-acceptance',
  'p3-real-services',
];
export const SINGLE_PASS_LANES = [
  'hosted-verify',
  'node-contracts',
  'linux-real-services',
  'windows-candidate',
  'real-service-acceptance',
  'fixture-acceptance',
  'acceptance-responsive',
  'p3-real-services',
];
export const LANES_BY_TOPOLOGY = { 'two-pass': TWO_PASS_LANES, 'single-pass': SINGLE_PASS_LANES };
const TOPOLOGIES = Object.keys(LANES_BY_TOPOLOGY);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

/** Checks the run's inputs and returns the summary. Throws, naming every problem, when any input is missing or malformed. */
export function buildRunSummary(input) {
  const problems = [];
  if (!TOPOLOGIES.includes(input.topology))
    problems.push('topology must be single-pass or two-pass');
  if (!Number.isInteger(input.attempt) || input.attempt < 1)
    problems.push('attempt must be a positive integer');
  if (typeof input.candidateSha !== 'string' || !SHA_PATTERN.test(input.candidateSha)) {
    problems.push('candidateSha must be a full 40-character commit SHA');
  }
  if (typeof input.verdict !== 'string' || input.verdict === '')
    problems.push('verdict is missing');
  for (const check of GATE_CHECKS) {
    if (typeof input.gateChecks?.[check] !== 'string' || input.gateChecks[check] === '') {
      problems.push(`gate check ${check} is missing`);
    }
  }
  const scenarioIds = Object.keys(input.scenarios ?? {});
  if (scenarioIds.length === 0) problems.push('scenarios are missing');
  for (const id of scenarioIds) {
    const scenario = input.scenarios[id];
    if (typeof scenario?.status !== 'string') problems.push(`scenario ${id} has no status`);
    if (typeof scenario?.firstAttemptPassed !== 'boolean')
      problems.push(`scenario ${id} has no firstAttemptPassed flag`);
    if (!Number.isInteger(scenario?.retries)) problems.push(`scenario ${id} has no retry count`);
  }
  if (typeof input.lifecycleTransitions !== 'object' || input.lifecycleTransitions === null) {
    problems.push('lifecycle transitions are missing');
  }
  const lanes = LANES_BY_TOPOLOGY[input.topology] ?? [];
  for (const lane of lanes) {
    if (typeof input.lanes?.[lane] !== 'string') problems.push(`lane ${lane} is missing`);
  }
  if (
    !Array.isArray(input.vitest?.executed) ||
    !input.vitest.executed.every((id) => typeof id === 'string')
  ) {
    problems.push('the executed Vitest test list is missing');
  }
  if (
    !Array.isArray(input.vitest?.failed) ||
    !input.vitest.failed.every((id) => typeof id === 'string')
  ) {
    problems.push('the failed Vitest test list is missing');
  }
  if (problems.length > 0) throw new Error(`The run summary is incomplete: ${problems.join('; ')}`);

  return {
    topology: input.topology,
    attempt: input.attempt,
    candidateSha: input.candidateSha,
    verdict: input.verdict,
    gateChecks: Object.fromEntries(GATE_CHECKS.map((check) => [check, input.gateChecks[check]])),
    scenarios: input.scenarios,
    lifecycleTransitions: input.lifecycleTransitions,
    lanes: Object.fromEntries(lanes.map((lane) => [lane, input.lanes[lane]])),
    vitest: {
      executed: [...new Set(input.vitest.executed)].sort(),
      failed: [...new Set(input.vitest.failed)].sort(),
    },
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new Error(`Expected --name value pairs, got: ${key}`);
    options[key.slice(2)] = value;
  }
  for (const name of ['input', 'out']) {
    if (!options[name]) throw new Error(`Missing --${name}`);
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const summary = buildRunSummary(JSON.parse(readFileSync(resolve(options.input), 'utf8')));
  writeFileSync(resolve(options.out), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `wrote run summary for ${summary.candidateSha} (${summary.topology}, attempt ${summary.attempt})\n`,
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
