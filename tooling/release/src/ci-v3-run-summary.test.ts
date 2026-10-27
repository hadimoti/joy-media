import { describe, expect, it } from 'vitest';
import { SHAPES } from './create-readiness-evidence.mjs';
import {
  buildRunSummary,
  GATE_CHECKS,
  LANES_BY_TOPOLOGY,
  SINGLE_PASS_LANES,
  TWO_PASS_LANES,
} from './ci-v3-run-summary.mjs';
import {
  compareShadowRuns,
  GATE_CHECKS as COMPARE_GATE_CHECKS,
  LANES_BY_TOPOLOGY as COMPARE_LANES_BY_TOPOLOGY,
  SINGLE_PASS_VERDICT,
  TWO_PASS_VERDICT,
} from './ci-v3-shadow-compare.mjs';

// Plan section 3.4 (D18): the shadow comparison needs one summary per run, and each summary must come from complete inputs.
const SHA = 'a'.repeat(40);

function runInputs(topology: 'two-pass' | 'single-pass') {
  const verdict = topology === 'two-pass' ? TWO_PASS_VERDICT : SINGLE_PASS_VERDICT;
  return {
    topology,
    attempt: 1,
    candidateSha: SHA,
    // The gate's decision. Both runs of one candidate decide the same way; the topology-specific verdict scenario is separate.
    verdict: 'pass',
    gateChecks: Object.fromEntries(GATE_CHECKS.map((check) => [check, 'pass'])),
    scenarios: {
      'desktop.lifecycle': { status: 'passed', firstAttemptPassed: true, retries: 0 },
      [verdict]: { status: 'passed', firstAttemptPassed: true, retries: 0 },
    },
    lifecycleTransitions: { installPrevious: 'passed', rollbackToKeptPrevious: 'passed' },
    lanes: Object.fromEntries(LANES_BY_TOPOLOGY[topology].map((lane) => [lane, 'success'])),
    vitest: { executed: ['suite > one', 'suite > two', 'suite > three'], failed: [] },
  };
}

/** The summary as the comparison reads it: the Vitest lists are sets there. */
function asComparable(summary: ReturnType<typeof buildRunSummary>) {
  return {
    ...summary,
    vitest: { executed: new Set(summary.vitest.executed), failed: new Set(summary.vitest.failed) },
  };
}

describe('shadow run summary', () => {
  it('keeps the gate-check and lane lists the comparison uses', () => {
    expect(GATE_CHECKS).toEqual(COMPARE_GATE_CHECKS);
    expect(LANES_BY_TOPOLOGY).toEqual(COMPARE_LANES_BY_TOPOLOGY);
    // Each topology's lanes are the gate's own lanes, so the summary and the gate cannot drift apart.
    expect(TWO_PASS_LANES).toEqual(SHAPES['two-pass'].lanes);
    expect(SINGLE_PASS_LANES).toEqual(SHAPES['single-pass'].lanes);
  });

  it('writes two summaries that the comparison accepts when the two runs agree', () => {
    const v2 = buildRunSummary(runInputs('two-pass'));
    const v3 = buildRunSummary(runInputs('single-pass'));
    expect(compareShadowRuns(asComparable(v2), asComparable(v3))).toEqual({
      ok: true,
      reasons: [],
      classification: { notRecordedInV3: 0, failedInV3: 0 },
    });
  });

  it('refuses incomplete inputs, and names each missing or malformed one', () => {
    const missingCheck = runInputs('single-pass');
    delete (missingCheck.gateChecks as Record<string, string>)['tests'];
    expect(() => buildRunSummary(missingCheck)).toThrow(/gate check tests is missing/u);

    const firstAttempt = { ...runInputs('single-pass'), attempt: 0 };
    expect(() => buildRunSummary(firstAttempt)).toThrow(/attempt must be a positive integer/u);

    const shortSha = { ...runInputs('single-pass'), candidateSha: 'abc123' };
    expect(() => buildRunSummary(shortSha)).toThrow(
      /candidateSha must be a full 40-character commit SHA/u,
    );

    const missingLane = runInputs('single-pass');
    delete (missingLane.lanes as Record<string, string>)['p3-real-services'];
    expect(() => buildRunSummary(missingLane)).toThrow(/lane p3-real-services is missing/u);

    const noVitest = {
      ...runInputs('single-pass'),
      vitest: { failed: [] },
    } as unknown as ReturnType<typeof runInputs>;
    expect(() => buildRunSummary(noVitest)).toThrow(/the executed Vitest test list is missing/u);
  });

  it('is refused by the comparison when v3 drops a test that v2 executed', () => {
    const v2 = buildRunSummary(runInputs('two-pass'));
    const dropped = runInputs('single-pass');
    dropped.vitest = { executed: ['suite > one', 'suite > two'], failed: [] };
    const v3 = buildRunSummary(dropped);
    const result = compareShadowRuns(asComparable(v2), asComparable(v3));
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/v3 did not record 1 test\(s\) that v2 executed/u);
  });

  it('is refused by the comparison when a release lane is not green in v3', () => {
    const v2 = buildRunSummary(runInputs('two-pass'));
    const red = runInputs('single-pass');
    red.lanes = { ...red.lanes, 'p3-real-services': 'failure' };
    const v3 = buildRunSummary(red);
    const result = compareShadowRuns(asComparable(v2), asComparable(v3));
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('v3 lane p3-real-services is not green');
  });
});
