// Tests for the run inputs the shadow comparison reads (plan section 3.4, D18). A complete run must produce a summary the writer
// accepts, and every missing or unverified input must be refused by name.
import { describe, expect, it } from 'vitest';
import { buildRunSummary, GATE_CHECKS, LANES_BY_TOPOLOGY } from './ci-v3-run-summary.mjs';
import { buildRunInputs, GATE_CHECK_IDS, vitestFromHostedReport } from './ci-v3-run-inputs.mjs';

const SHA = 'a'.repeat(40);
const TRANSITIONS = { installPrevious: 'passed', uninstall: 'passed', userDataPreserved: 'passed' };
const VITEST = { executed: ['apps/a/src/a.test.ts::suite passes'], failed: [] };
const VERDICT = {
  'single-pass': 'release.exact-candidate',
};

type Topology = 'single-pass';

function fixture(topology: Topology, overrides: Record<string, unknown> = {}) {
  const needs = Object.fromEntries(
    LANES_BY_TOPOLOGY[topology].map((lane) => [lane, { result: 'success', outputs: {} }]),
  );
  const gate = {
    passed: true,
    checks: GATE_CHECK_IDS.map((id) => ({ id, status: 'passed', message: 'ok' })),
  };
  const readiness = {
    scenarioResults: [
      { id: 'cli.render.playable', status: 'passed', firstAttemptPassed: true, retries: 0 },
      { id: VERDICT[topology], status: 'passed', firstAttemptPassed: true, retries: 0 },
    ],
  };
  const windows = { desktopLifecycle: { transitions: TRANSITIONS } };
  return {
    topology,
    needs,
    gate,
    readiness,
    windows,
    vitest: VITEST,
    candidateSha: SHA,
    attempt: '1',
    ...overrides,
  } as Parameters<typeof buildRunInputs>[0];
}

describe('run inputs for the shadow comparison', () => {
  it('pins the 17 gate checks against the shadow summary writer list', () => {
    expect(GATE_CHECK_IDS).toEqual(GATE_CHECKS);
    expect(GATE_CHECK_IDS).toHaveLength(17);
  });

  it('builds single-pass inputs that the run summary writer accepts, with the nine lanes', () => {
    const inputs = buildRunInputs(fixture('single-pass'));
    expect(inputs.topology).toBe('single-pass');
    expect(inputs.attempt).toBe(1);
    expect(inputs.verdict).toBe('passed');
    expect(inputs.vitest.executed).toEqual(['apps/a/src/a.test.ts::suite passes']);
    const summary = buildRunSummary(inputs);
    expect(Object.keys(summary.lanes).sort()).toEqual([...LANES_BY_TOPOLOGY['single-pass']].sort());
    expect(summary.gateChecks.tests).toBe('passed');
  });

  it('refuses a run whose needs context lacks one of its topology lanes', () => {
    const base = fixture('single-pass');
    const needs: Record<string, unknown> = { ...base.needs };
    delete needs['fixture-acceptance'];
    expect(() => buildRunInputs(fixture('single-pass', { needs }))).toThrow(
      /no result for fixture-acceptance/u,
    );
  });

  it('refuses a topology it does not know', () => {
    expect(() => buildRunInputs(fixture('single-pass', { topology: 'three-pass' }))).toThrow(
      /unknown topology/u,
    );
  });

  it('refuses a gate report that lacks one of the 17 checks', () => {
    const gate = fixture('single-pass').gate as { checks: { id: string }[] };
    const checks = gate.checks.filter((check) => check.id !== 'sbom');
    expect(() =>
      buildRunInputs(fixture('single-pass', { gate: { passed: true, checks } })),
    ).toThrow(/no sbom check/u);
  });

  it('refuses a gate report with no check list at all', () => {
    expect(() => buildRunInputs(fixture('single-pass', { gate: { passed: true } }))).toThrow(
      /no check list/u,
    );
  });

  it('refuses readiness evidence with no scenario results', () => {
    expect(() => buildRunInputs(fixture('single-pass', { readiness: {} }))).toThrow(
      /no scenario results/u,
    );
  });

  it('refuses a Windows record with no lifecycle transitions', () => {
    expect(() =>
      buildRunInputs(fixture('single-pass', { windows: { desktopLifecycle: {} } })),
    ).toThrow(/no lifecycle transitions/u);
  });

  it('refuses a run that names no Vitest results', () => {
    expect(() => buildRunInputs(fixture('single-pass', { vitest: undefined }))).toThrow(
      /names no verified Vitest results/u,
    );
  });

  it('records a failed gate as a failed verdict, so a failed run never reads as passed', () => {
    const gate = { passed: false, checks: fixture('single-pass').gate.checks };
    expect(buildRunInputs(fixture('single-pass', { gate })).verdict).toBe('failed');
  });
});

describe('where the Vitest results come from', () => {
  const hostedOk = {
    merge: { ok: true },
    executed: [
      { id: 'a.test.ts::one', status: 'passed' },
      { id: 'a.test.ts::two', status: 'skipped' },
      { id: 'a.test.ts::three', status: 'failed' },
    ],
  };

  it('takes the v3 results from a hosted-verify report whose merge passed', () => {
    expect(vitestFromHostedReport(hostedOk)).toEqual({
      executed: ['a.test.ts::one', 'a.test.ts::three'],
      failed: ['a.test.ts::three'],
    });
  });

  it('refuses a hosted-verify report whose merge did not pass', () => {
    expect(() => vitestFromHostedReport({ ...hostedOk, merge: { ok: false } })).toThrow(
      /no verified test list/u,
    );
  });
});
