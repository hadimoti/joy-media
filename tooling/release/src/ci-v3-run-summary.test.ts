import { describe, expect, it } from 'vitest';
import { SHAPES } from './create-readiness-evidence.mjs';
import {
  buildRunSummary,
  GATE_CHECKS,
  LANES_BY_TOPOLOGY,
  SINGLE_PASS_LANES,
  TWO_PASS_LANES,
} from './ci-v3-run-summary.mjs';

// Plan section 8b: one run summary per gate run. The summary is written only from complete inputs.
const SHA = 'a'.repeat(40);

function runInputs(topology: 'two-pass' | 'single-pass') {
  const verdict = SHAPES[topology].verdict;
  return {
    topology,
    attempt: 1,
    candidateSha: SHA,
    // The gate's decision. The topology-specific verdict scenario is separate.
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

describe('run summary', () => {
  it("keeps each topology's lanes equal to the gate's own lanes", () => {
    // Each topology's lanes are the gate's own lanes, so the summary and the gate cannot drift apart.
    expect(TWO_PASS_LANES).toEqual(SHAPES['two-pass'].lanes);
    expect(SINGLE_PASS_LANES).toEqual(SHAPES['single-pass'].lanes);
  });

  it('writes a complete summary for each topology, with its own lanes', () => {
    for (const topology of ['two-pass', 'single-pass'] as const) {
      const summary = buildRunSummary(runInputs(topology));
      expect(summary.topology).toBe(topology);
      expect(Object.keys(summary.lanes).sort()).toEqual([...LANES_BY_TOPOLOGY[topology]].sort());
      expect(summary.vitest.executed).toEqual(['suite > one', 'suite > three', 'suite > two']);
    }
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
});
