import { describe, expect, it } from 'vitest';
import { evaluateGateSummary } from './ci-gate-summary.js';

const EXPECTED = 6;

describe('release-gate summary evaluator', () => {
  it('passes when every one of the expected lanes is success', () => {
    expect(evaluateGateSummary(JSON.stringify(Array(EXPECTED).fill('success')), EXPECTED)).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it('fails on a failure result', () => {
    const r = evaluateGateSummary(
      JSON.stringify(['success', 'success', 'failure', 'success', 'success', 'success']),
      EXPECTED,
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/#2="failure"/);
  });

  it('fails on a cancelled result', () => {
    const r = evaluateGateSummary(
      JSON.stringify(['success', 'cancelled', 'success', 'success', 'success', 'success']),
      EXPECTED,
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/#1="cancelled"/);
  });

  it('fails on a skipped result (a required lane that did not run)', () => {
    const r = evaluateGateSummary(
      JSON.stringify(['success', 'success', 'success', 'skipped', 'success', 'success']),
      EXPECTED,
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/#3="skipped"/);
  });

  it('fails when a required job is missing (short array)', () => {
    const r = evaluateGateSummary(JSON.stringify(Array(EXPECTED - 1).fill('success')), EXPECTED);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/expected 6 release lanes, got 5/);
  });

  it('fails on an empty result array', () => {
    const r = evaluateGateSummary('[]', EXPECTED);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/no lane results/);
  });

  it('fails on malformed JSON rather than passing silently', () => {
    const r = evaluateGateSummary('[success, success', EXPECTED);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/not valid JSON/);
  });

  it('fails on a non-array JSON value', () => {
    const r = evaluateGateSummary('"success"', EXPECTED);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/not a JSON array/);
  });

  it('reports both the short-array and the non-success problems at once', () => {
    const r = evaluateGateSummary(JSON.stringify(['success', 'failure', 'skipped']), EXPECTED);
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects a non-integer expected lane count', () => {
    const r = evaluateGateSummary(JSON.stringify(['success']), 'six');
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/expected lane count is invalid/);
  });
});
