import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateGateSummary } from './ci-gate-summary.js';

const RELEASE_WORKFLOW = readFileSync(
  new URL('../../../.github/workflows/release-candidate-v2.yml', import.meta.url),
  'utf8',
);

const LANES = [
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
const NAMES = LANES.join(',');
const needs = (overrides: Record<string, string> = {}) =>
  JSON.stringify(Object.fromEntries(LANES.map((n) => [n, { result: overrides[n] ?? 'success' }])));

describe('release-gate summary evaluator — name-keyed', () => {
  it('passes when every expected lane is present and success', () => {
    expect(evaluateGateSummary(needs(), NAMES)).toEqual({ ok: true, reasons: [] });
  });

  it('keeps hosted PostgreSQL ledger verification required by the exact-candidate gate', () => {
    const jobStart = RELEASE_WORKFLOW.indexOf('\n  node-contracts:\n');
    const jobEnd = RELEASE_WORKFLOW.indexOf('\n  editor-web-bundle:\n', jobStart);
    const job = RELEASE_WORKFLOW.slice(jobStart, jobEnd);

    expect(jobStart).toBeGreaterThanOrEqual(0);
    expect(job).toContain('runs-on: ubuntu-24.04');
    expect(job).toContain('image: postgres:16');
    expect(job).toContain("node: ['22.17.0', 24]");
    expect(job).toContain('JOY_TEST_DATABASE_URL');
    expect(job).toContain('JOY_MEDIA_EDGE_URL: off');
    expect(job).toContain('test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"');
    expect(job).toContain('vitest run apps/cli/src --no-file-parallelism');
    expect(RELEASE_WORKFLOW).toContain(
      "'linux-real-services,windows-p0-real-services,node-contracts,windows-worker-clean,acceptance-primary,acceptance-responsive,prod-build-smoke,real-service-acceptance,p3-real-services'",
    );
    const gateStart = RELEASE_WORKFLOW.indexOf('\n  gate-summary:\n');
    expect(RELEASE_WORKFLOW.slice(gateStart)).toContain('        node-contracts,');
  });

  it('fails on a failure / cancelled / skipped / timed_out result, naming the lane', () => {
    for (const bad of ['failure', 'cancelled', 'skipped', 'timed_out']) {
      const r = evaluateGateSummary(needs({ 'acceptance-primary': bad }), NAMES);
      expect(r.ok).toBe(false);
      expect(r.reasons.join(' ')).toMatch(new RegExp(`acceptance-primary="${bad}"`));
    }
  });

  it('fails when a required lane is removed from needs (contract drift), even if a count would still match', () => {
    const short = JSON.stringify(
      Object.fromEntries(LANES.slice(1).map((n) => [n, { result: 'success' }])),
    );
    const r = evaluateGateSummary(short, NAMES);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(
      /required lane\(s\) absent from needs: linux-real-services/,
    );
  });

  it('fails on an unexpected extra lane in needs', () => {
    const extra = JSON.parse(needs());
    extra['sneaky-new-lane'] = { result: 'success' };
    const r = evaluateGateSummary(JSON.stringify(extra), NAMES);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(
      /unexpected lane\(s\) in needs \(contract drift\): sneaky-new-lane/,
    );
  });

  it('reports the missing lane AND the non-success lane at once', () => {
    const partial = JSON.stringify({
      'windows-worker-clean': { result: 'failure' },
      'acceptance-primary': { result: 'success' },
    });
    const r = evaluateGateSummary(partial, NAMES);
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('fails on non-object / malformed JSON rather than passing silently', () => {
    expect(evaluateGateSummary('["success"]', NAMES).ok).toBe(false);
    expect(evaluateGateSummary('{not json', NAMES).ok).toBe(false);
    expect(evaluateGateSummary('null', NAMES).ok).toBe(false);
  });
});

describe('release-gate summary evaluator — legacy count mode (back-compat)', () => {
  it('passes when every one of the expected lanes is success', () => {
    expect(evaluateGateSummary(JSON.stringify(Array(6).fill('success')), 6)).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it('fails on a non-success entry / short array / empty / malformed', () => {
    expect(evaluateGateSummary(JSON.stringify(['success', 'failure']), 2).ok).toBe(false);
    expect(evaluateGateSummary(JSON.stringify(Array(5).fill('success')), 6).ok).toBe(false);
    expect(evaluateGateSummary('[]', 6).ok).toBe(false);
    expect(evaluateGateSummary('[success', 6).ok).toBe(false);
    expect(evaluateGateSummary('"success"', 6).ok).toBe(false);
  });

  it('treats a bare integer string as legacy count mode', () => {
    expect(evaluateGateSummary(JSON.stringify(['success', 'success', 'success']), '3').ok).toBe(
      true,
    );
  });

  it('a non-integer, non-empty spec is a name list, not a count', () => {
    const r = evaluateGateSummary(JSON.stringify({ a: { result: 'success' } }), 'a');
    expect(r.ok).toBe(true);
  });
});
