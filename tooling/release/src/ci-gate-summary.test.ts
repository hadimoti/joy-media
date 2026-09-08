import { describe, expect, it } from 'vitest';
import { evaluateGateSummary } from './ci-gate-summary.js';

const LANES = [
  'linux-real-services',
  'windows-worker-clean',
  'acceptance-primary',
  'acceptance-responsive',
  'prod-build-smoke',
  'real-service-acceptance',
];
const NAMES = LANES.join(',');
const needs = (overrides: Record<string, string> = {}) =>
  JSON.stringify(Object.fromEntries(LANES.map((n) => [n, { result: overrides[n] ?? 'success' }])));

describe('release-gate summary evaluator — name-keyed', () => {
  it('passes when every expected lane is present and success', () => {
    expect(evaluateGateSummary(needs(), NAMES)).toEqual({ ok: true, reasons: [] });
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
