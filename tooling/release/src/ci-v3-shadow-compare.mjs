// Compares one v2 shadow run with one v3 shadow run of the same frozen commit (plan §3.4, D18).
//
//   node --experimental-strip-types ci-v3-shadow-compare.mjs <v2-run.json> <v3-run.json>
//
// Each run file is a summary the shadow job writes after its gate: the topology, the 17 check results, the verdict, the
// scenario outcomes, the lifecycle transitions, the nine lane results, the attempt, the candidate SHA, and the executed
// Vitest test IDs. The comparison is pure. It reads two files and prints one receipt, and it writes nothing else.
//
// Equivalence means: the same candidate, the same verdict, the same 17 check results, the same outcome for every
// lifecycle scenario, the same lifecycle transitions, the nine lanes green in both, the first attempt in both, and every
// test v2 executed still executed in v3 (compareV2WithV3). A v3 run may execute extra tests. It may not drop one.
import { compareV2WithV3 } from './ci-v3-equivalence.ts';
import { LANES_BY_TOPOLOGY } from './ci-v3-run-summary.mjs';

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
export const TWO_PASS_VERDICT = 'release.exact-candidate-two-pass';
export const SINGLE_PASS_VERDICT = 'release.exact-candidate';
// Each run is judged on the lanes of its own topology: nine for v2, eight for v3 (ci-v3-run-summary.mjs holds both lists).
export { LANES_BY_TOPOLOGY };

/** Compares the two shadow runs. Returns { ok, reasons }; every reason names one rule that failed. */
export function compareShadowRuns(v2, v3) {
  const reasons = [];
  if ((v2.topology ?? 'two-pass') !== 'two-pass') reasons.push('the v2 run is not a two-pass run');
  if (v3.topology !== 'single-pass') reasons.push('the v3 run is not a single-pass run');
  if (v2.attempt !== 1 || v3.attempt !== 1)
    reasons.push('both runs must be the first attempt; a re-run proves nothing');
  if (v2.candidateSha !== v3.candidateSha) reasons.push('the runs name different candidate SHAs');
  if (v2.verdict !== v3.verdict)
    reasons.push(`verdicts differ: v2 ${v2.verdict}, v3 ${v3.verdict}`);

  for (const check of GATE_CHECKS) {
    const left = v2.gateChecks?.[check];
    const right = v3.gateChecks?.[check];
    if (left === undefined || right === undefined)
      reasons.push(`check ${check} is missing from a run`);
    else if (left !== right) reasons.push(`check ${check} differs: v2 ${left}, v3 ${right}`);
  }

  const v2Lifecycle = Object.keys(v2.scenarios ?? {}).filter((id) => id !== TWO_PASS_VERDICT);
  const v3Lifecycle = Object.keys(v3.scenarios ?? {}).filter((id) => id !== SINGLE_PASS_VERDICT);
  if (v2Lifecycle.slice().sort().join(',') !== v3Lifecycle.slice().sort().join(',')) {
    reasons.push('the lifecycle scenario sets differ');
  }
  for (const id of v2Lifecycle) {
    const left = v2.scenarios[id];
    const right = v3.scenarios?.[id];
    if (right === undefined) reasons.push(`scenario ${id} is missing from v3`);
    else if (left.status !== right.status)
      reasons.push(`scenario ${id} differs: v2 ${left.status}, v3 ${right.status}`);
  }
  for (const [label, run] of [
    ['v2', v2],
    ['v3', v3],
  ]) {
    const verdict = run.topology === 'single-pass' ? SINGLE_PASS_VERDICT : TWO_PASS_VERDICT;
    const scenario = run.scenarios?.[verdict];
    if (
      scenario?.status !== 'passed' ||
      scenario.firstAttemptPassed !== true ||
      scenario.retries !== 0
    ) {
      reasons.push(`${label} verdict scenario ${verdict} did not pass on its first attempt`);
    }
    for (const id of Object.keys(run.scenarios ?? {})) {
      const entry = run.scenarios[id];
      if (entry.status === 'passed' && (entry.firstAttemptPassed !== true || entry.retries !== 0)) {
        reasons.push(`${label} scenario ${id} needed a retry`);
      }
    }
  }

  const transitionsLeft = JSON.stringify(Object.entries(v2.lifecycleTransitions ?? {}).sort());
  const transitionsRight = JSON.stringify(Object.entries(v3.lifecycleTransitions ?? {}).sort());
  if (transitionsLeft !== transitionsRight) reasons.push('the lifecycle transitions differ');

  for (const [label, run] of [
    ['v2', v2],
    ['v3', v3],
  ]) {
    for (const lane of LANES_BY_TOPOLOGY[run.topology ?? 'two-pass'] ?? []) {
      if (run.lanes?.[lane] !== 'success') reasons.push(`${label} lane ${lane} is not green`);
    }
  }

  const tests = compareV2WithV3(v2.vitest, v3.vitest);
  // Two different facts. A test v2 ran that v3's summary does not name is a recording gap, not a failure. A test v3 names as failed
  // is an actual failure. The receipt reports the two counts separately.
  const notRecordedInV3 = tests.missingInV3.length;
  const failedInV3 = v3.vitest.failed.size;
  if (!tests.verdictMatches) reasons.push('the Vitest verdicts differ');
  if (failedInV3 > 0) reasons.push(`v3 recorded ${failedInV3} failed test(s)`);
  if (notRecordedInV3 > 0)
    reasons.push(
      `v3 did not record ${notRecordedInV3} test(s) that v2 executed (a recording gap, not a failure)`,
    );

  return { ok: reasons.length === 0, reasons, classification: { notRecordedInV3, failedInV3 } };
}

function toSummary(run) {
  return {
    executed: new Set(run.vitest?.executed ?? []),
    failed: new Set(run.vitest?.failed ?? []),
  };
}

async function main(args) {
  const { readFileSync } = await import('node:fs');
  if (args.length !== 2)
    throw new Error('usage: ci-v3-shadow-compare.mjs <v2-run.json> <v3-run.json>');
  const [v2, v3] = args.map((path) => JSON.parse(readFileSync(path, 'utf8')));
  const receipt = compareShadowRuns(
    { ...v2, vitest: toSummary(v2) },
    { ...v3, vitest: toSummary(v3) },
  );
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return receipt.ok ? 0 : 1;
}

const { fileURLToPath } = await import('node:url');
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
