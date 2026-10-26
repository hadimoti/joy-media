import { describe, expect, it } from 'vitest';
import { compareShadowRuns, GATE_CHECKS, RELEASE_LANES } from './ci-v3-shadow-compare.mjs';

// A shadow pair that agrees everywhere. Each negative control changes exactly one fact of the v3 run.
const SHA = 'a'.repeat(40);
const LIFECYCLE = [
  'cli.render.playable',
  'cli.render.unsupported-features',
  'cli.render.failure-recovery',
  'cli.render.windows-entrypoints',
  'project.persistence.fresh-process',
  'desktop.app.restart-save-export',
  'desktop.windows.installed-lifecycle',
  'desktop.export-media-semantics',
];
const PASSED = { status: 'passed', firstAttemptPassed: true, retries: 0 };

function scenarios(verdict: string) {
  return Object.fromEntries([...LIFECYCLE.map((id) => [id, PASSED]), [verdict, PASSED]]);
}

const TRANSITIONS = Object.fromEntries(
  [
    'installPrevious',
    'upgradeCandidate',
    'repairCandidate',
    'rollbackToKeptPrevious',
    'updateRefusedWhileFileHeld',
    'tamperedUpdateRefused',
    'wrongKeyManifestRefused',
    'uninstall',
    'userDataPreserved',
  ].map((name) => [name, 'passed']),
);
const CHECKS = Object.fromEntries(GATE_CHECKS.map((check) => [check, 'passed']));
const LANES = Object.fromEntries(RELEASE_LANES.map((lane) => [lane, 'success']));

function baseline(topology: 'two-pass' | 'single-pass') {
  const verdict =
    topology === 'two-pass' ? 'release.exact-candidate-two-pass' : 'release.exact-candidate';
  return {
    topology,
    attempt: 1,
    candidateSha: SHA,
    verdict: 'ready',
    gateChecks: { ...CHECKS },
    scenarios: scenarios(verdict),
    lifecycleTransitions: { ...TRANSITIONS },
    lanes: { ...LANES },
    vitest: { executed: new Set(['a::1', 'a::2', 'b::1']), failed: new Set<string>() },
  };
}

function pair(change: (v3: ReturnType<typeof baseline>) => void = () => undefined) {
  const v2 = { ...baseline('two-pass') };
  const v3 = { ...baseline('single-pass') };
  change(v3);
  return compareShadowRuns(v2 as never, v3 as never);
}

describe('v2 and v3 shadow comparison (D18)', () => {
  it('accepts a pair that agrees on every fact the design names', () => {
    expect(pair()).toEqual({ ok: true, reasons: [] });
  });

  it('accepts extra tests in v3, which the design allows, and refuses a dropped one', () => {
    expect(
      pair(
        (v3) =>
          (v3.vitest = {
            executed: new Set(['a::1', 'a::2', 'b::1', 'c::new']),
            failed: new Set(),
          }),
      ),
    ).toMatchObject({ ok: true });
    const dropped = pair(
      (v3) => (v3.vitest = { executed: new Set(['a::1', 'a::2']), failed: new Set() }),
    );
    expect(dropped.ok).toBe(false);
    expect(dropped.reasons.join(';')).toMatch(/v3 dropped 1 test\(s\) that v2 executed/u);
  });

  it('refuses a different verdict', () => {
    expect(pair((v3) => (v3.verdict = 'blocked')).reasons.join(';')).toMatch(/verdicts differ/u);
  });

  it('refuses a gate check whose result differs', () => {
    expect(
      pair((v3) => (v3.gateChecks['windows-acceptance'] = 'failed')).reasons.join(';'),
    ).toMatch(/check windows-acceptance differs/u);
  });

  it('refuses a missing gate check', () => {
    expect(pair((v3) => delete v3.gateChecks['sbom']).reasons.join(';')).toMatch(
      /check sbom is missing from a run/u,
    );
  });

  it('refuses a re-run in either run, because a re-run cannot prove first-attempt success', () => {
    expect(pair((v3) => (v3.attempt = 2)).reasons.join(';')).toMatch(
      /both runs must be the first attempt/u,
    );
  });

  it('refuses a scenario that needed a retry', () => {
    const reasons = pair(
      (v3) =>
        (v3.scenarios['cli.render.playable'] = {
          status: 'passed',
          firstAttemptPassed: false,
          retries: 1,
        }),
    ).reasons;
    expect(reasons.join(';')).toMatch(/v3 scenario cli\.render\.playable needed a retry/u);
  });

  it('refuses a lifecycle scenario whose status differs', () => {
    expect(
      pair(
        (v3) =>
          (v3.scenarios['desktop.export-media-semantics'] = {
            status: 'failed',
            firstAttemptPassed: false,
            retries: 0,
          }),
      ).reasons.join(';'),
    ).toMatch(/scenario desktop\.export-media-semantics differs/u);
  });

  it('refuses a lifecycle transition that differs or is missing', () => {
    expect(pair((v3) => (v3.lifecycleTransitions.uninstall = 'failed')).reasons.join(';')).toMatch(
      /lifecycle transitions differ/u,
    );
    expect(
      pair((v3) => delete v3.lifecycleTransitions.userDataPreserved).reasons.join(';'),
    ).toMatch(/lifecycle transitions differ/u);
  });

  it('refuses a lane that is not green in v3, and a lane that is not green in v2', () => {
    expect(pair((v3) => (v3.lanes['p3-real-services'] = 'failure')).reasons.join(';')).toMatch(
      /v3 lane p3-real-services is not green/u,
    );
    const v2Failing = { ...baseline('two-pass'), lanes: { ...LANES, 'node-contracts': 'failure' } };
    const result = compareShadowRuns(v2Failing as never, baseline('single-pass') as never);
    expect(result.reasons.join(';')).toMatch(/v2 lane node-contracts is not green/u);
  });

  it('refuses runs of different candidates, and a v3 run that is not single-pass', () => {
    expect(pair((v3) => (v3.candidateSha = 'b'.repeat(40))).reasons.join(';')).toMatch(
      /different candidate SHAs/u,
    );
    expect(pair((v3) => (v3.topology = 'two-pass' as never)).reasons.join(';')).toMatch(
      /the v3 run is not a single-pass run/u,
    );
  });

  it('refuses a v3 run whose verdict scenario did not pass on its first attempt', () => {
    expect(
      pair(
        (v3) =>
          (v3.scenarios['release.exact-candidate'] = {
            status: 'passed',
            firstAttemptPassed: true,
            retries: 1,
          }),
      ).reasons.join(';'),
    ).toMatch(/v3 verdict scenario release\.exact-candidate did not pass on its first attempt/u);
  });
});
