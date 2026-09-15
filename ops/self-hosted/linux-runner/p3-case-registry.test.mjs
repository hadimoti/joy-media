/* P3 case-registry + validator tests.
 *
 * Runs with: pnpm exec vitest run ops/self-hosted/linux-runner/p3-case-registry.test.mjs
 *
 * These tests intentionally use SYNTHETIC rows; they validate the registry
 * and validator contract and never call them acceptance evidence.
 */

import { describe, expect, it } from 'vitest';

import {
  P3_CASE_KINDS,
  P3_CASE_REGISTRY,
  P3_PACK_IDS,
  P3_PRESETS,
  P3_RESULTS,
  attachProvenance,
  getP3Case,
  isP3CaseId,
  markResult,
  markStarted,
  newP3Matrix,
  p3Provenance,
  validateP3Matrix,
} from './p3-case-registry.mjs';

const VALID_PROVENANCE = p3Provenance({
  candidateSha: '0c70c61cdfc692e04a7c46d3b37a6e94a1d7adfe',
  runId: '34540790794',
  runAttempt: '1',
  pass: '1',
  issuedAt: '2026-09-11T01:00:00.000Z',
});

function passAll(matrix) {
  return matrix.map((row) => ({
    ...row,
    phase: 'PASS',
    result: 'PASS',
    reason: null,
  }));
}

function attachValidProv(matrix) {
  return attachProvenance(matrix, VALID_PROVENANCE);
}

describe('p3-case-registry shape', () => {
  it('exports exactly 5 packs, 2 presets, 2 kinds, 20 case rows', () => {
    expect(P3_PACK_IDS).toHaveLength(5);
    expect(P3_PRESETS).toHaveLength(2);
    expect(P3_CASE_KINDS).toEqual(['export', 'cancel']);
    expect(P3_CASE_REGISTRY.rows).toHaveLength(20);
    expect(P3_CASE_REGISTRY.byId.size).toBe(20);
  });

  it('emits export and cancel identities for every pack × preset', () => {
    for (const pack of P3_PACK_IDS) {
      for (const preset of P3_PRESETS) {
        expect(isP3CaseId(`${pack}/${preset.id}`)).toBe(true);
        expect(isP3CaseId(`cancel/${pack}/${preset.id}`)).toBe(true);
        const exp = getP3Case(`${pack}/${preset.id}`);
        expect(exp?.kind).toBe('export');
        const cnl = getP3Case(`cancel/${pack}/${preset.id}`);
        expect(cnl?.kind).toBe('cancel');
      }
    }
  });

  it('every row starts with NOT RUN / NOT RUN', () => {
    const matrix = newP3Matrix();
    expect(matrix).toHaveLength(20);
    for (const row of matrix) {
      expect(row.phase).toBe('NOT RUN');
      expect(row.result).toBe('NOT RUN');
      expect(row.reason).toBeNull();
    }
  });
});

describe('validateP3Matrix — happy path (synthetic only)', () => {
  it('accepts 20 valid PASS rows with matching provenance', () => {
    const matrix = attachValidProv(passAll(newP3Matrix()));
    const result = validateP3Matrix(matrix, VALID_PROVENANCE);
    expect(result.ok).toBe(true);
  });

  it('accepts a browser-issued timestamp that differs from the harness clock', () => {
    const browserProvenance = { ...VALID_PROVENANCE, issuedAt: '2026-09-11T05:59:59.123Z' };
    const matrix = attachProvenance(passAll(newP3Matrix()), browserProvenance);
    const result = validateP3Matrix(matrix, {
      candidateSha: VALID_PROVENANCE.candidateSha,
      runId: VALID_PROVENANCE.runId,
      runAttempt: VALID_PROVENANCE.runAttempt,
      pass: VALID_PROVENANCE.pass,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts 20 valid PASS rows without provenance (provenance optional)', () => {
    const matrix = passAll(newP3Matrix());
    const result = validateP3Matrix(matrix);
    expect(result.ok).toBe(true);
  });
});

describe('validateP3Matrix — provenance rejection', () => {
  it('rejects a matrix whose candidateSha is stale', () => {
    const matrix = attachValidProv(passAll(newP3Matrix()));
    const stale = p3Provenance({ ...VALID_PROVENANCE, candidateSha: 'a'.repeat(40) });
    const result = validateP3Matrix(matrix, stale);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.startsWith('provenance:mismatch:candidateSha'))).toBe(
      true,
    );
  });

  it('rejects rows without provenance when one is required', () => {
    const matrix = passAll(newP3Matrix());
    const result = validateP3Matrix(matrix, VALID_PROVENANCE);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('provenance:missing-on-row:0');
  });

  it('checks provenance on every row, including a late missing row', () => {
    const matrix = attachValidProv(passAll(newP3Matrix()));
    delete matrix[19].provenance;
    const result = validateP3Matrix(matrix, VALID_PROVENANCE);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('provenance:missing-on-row:19');
  });

  it('rejects a row whose issuedAt differs from the browser timestamp', () => {
    const matrix = attachValidProv(passAll(newP3Matrix()));
    matrix[19] = {
      ...matrix[19],
      provenance: { ...VALID_PROVENANCE, issuedAt: '2026-09-11T06:00:00.000Z' },
    };
    const result = validateP3Matrix(matrix, VALID_PROVENANCE);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.startsWith('provenance:mismatch:issuedAt'))).toBe(true);
  });

  it('rejects mismatch on runId / runAttempt / pass / issuedAt', () => {
    const overrides = {
      runId: '99999999999',
      runAttempt: '9',
      pass: '2',
      issuedAt: '2026-09-11T02:00:00.000Z',
    };
    for (const field of Object.keys(overrides)) {
      const matrix = attachValidProv(passAll(newP3Matrix()));
      const mismatched = p3Provenance({ ...VALID_PROVENANCE, [field]: overrides[field] });
      const result = validateP3Matrix(matrix, mismatched);
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.startsWith(`provenance:mismatch:${field}`))).toBe(true);
    }
  });
});

describe('validateP3Matrix — identity contract', () => {
  it('rejects a 19-of-20 matrix (missing one row)', () => {
    const matrix = attachValidProv(passAll(newP3Matrix()));
    matrix.pop();
    const result = validateP3Matrix(matrix, VALID_PROVENANCE);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/^matrix:length=19/);
    expect(result.problems.some((p) => p.startsWith('missing:'))).toBe(true);
  });

  it('rejects a 21-of-20 matrix (extra unknown row)', () => {
    const matrix = attachValidProv(passAll(newP3Matrix()));
    matrix.push({
      caseId: 'phantom/row',
      pack: 'editorial-clean',
      preset: 'reels-1080',
      kind: 'export',
      phase: 'PASS',
      result: 'PASS',
      reason: null,
      provenance: { ...VALID_PROVENANCE },
    });
    const result = validateP3Matrix(matrix, VALID_PROVENANCE);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/^matrix:length=21/);
  });

  it('rejects duplicate caseIds', () => {
    const matrix = attachValidProv(passAll(newP3Matrix()));
    matrix[1] = { ...matrix[0] };
    const result = validateP3Matrix(matrix, VALID_PROVENANCE);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.startsWith('duplicate:'))).toBe(true);
  });

  it('rejects unknown caseIds', () => {
    const matrix = attachValidProv(passAll(newP3Matrix()));
    matrix[0] = { ...matrix[0], caseId: 'not-a-real-case' };
    const result = validateP3Matrix(matrix, VALID_PROVENANCE);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p === 'unknown:not-a-real-case')).toBe(true);
  });

  it('rejects wrong kind (export labeled as cancel)', () => {
    const matrix = attachValidProv(passAll(newP3Matrix()));
    const idx = matrix.findIndex((r) => r.caseId === 'editorial-clean/reels-1080');
    matrix[idx] = { ...matrix[idx], kind: 'cancel' };
    const result = validateP3Matrix(matrix, VALID_PROVENANCE);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.startsWith('wrong-kind:'))).toBe(true);
  });

  it('rejects wrong pack id on a row', () => {
    const matrix = attachValidProv(passAll(newP3Matrix()));
    const idx = matrix.findIndex((r) => r.caseId === 'editorial-clean/reels-1080');
    matrix[idx] = { ...matrix[idx], pack: 'music-pulse' };
    const result = validateP3Matrix(matrix, VALID_PROVENANCE);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.startsWith('wrong-pack:'))).toBe(true);
  });

  it('rejects wrong preset id on a row', () => {
    const matrix = attachValidProv(passAll(newP3Matrix()));
    const idx = matrix.findIndex((r) => r.caseId === 'editorial-clean/reels-1080');
    matrix[idx] = { ...matrix[idx], preset: 'youtube-1080' };
    const result = validateP3Matrix(matrix, VALID_PROVENANCE);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.startsWith('wrong-preset:'))).toBe(true);
  });

  it('rejects malformed result strings', () => {
    const matrix = attachValidProv(passAll(newP3Matrix()));
    matrix[0] = { ...matrix[0], result: 'OK', phase: 'PASS' };
    const result = validateP3Matrix(matrix, VALID_PROVENANCE);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.startsWith('bad-result:'))).toBe(true);
  });

  it('rejects any FAIL row (PASS is the only acceptable final state)', () => {
    const matrix = attachValidProv(passAll(newP3Matrix()));
    matrix[2] = { ...matrix[2], result: 'FAIL', phase: 'FAIL', reason: 'synthetic' };
    const result = validateP3Matrix(matrix, VALID_PROVENANCE);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p === `not-pass:${matrix[2].caseId}:FAIL`)).toBe(true);
  });

  it('rejects any NOT RUN row (even one unstarted case fails the lane)', () => {
    const matrix = attachValidProv(passAll(newP3Matrix()));
    matrix[3] = { ...matrix[3], result: 'NOT RUN', phase: 'NOT RUN' };
    const result = validateP3Matrix(matrix, VALID_PROVENANCE);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p === `not-pass:${matrix[3].caseId}:NOT RUN`)).toBe(true);
  });

  it('rejects a matrix with too few rows even if every present row PASSes', () => {
    const short = attachValidProv(passAll(newP3Matrix().slice(0, 10)));
    const result = validateP3Matrix(short, VALID_PROVENANCE);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/^matrix:length=10/);
    expect(result.problems.filter((p) => p.startsWith('missing:')).length).toBe(10);
  });

  it('rejects non-array input', () => {
    const result = validateP3Matrix('not-a-matrix');
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['matrix:not-array']);
  });

  it('rejects a row missing caseId', () => {
    const matrix = attachValidProv(passAll(newP3Matrix()));
    matrix[0] = { ...matrix[0] };
    delete matrix[0].caseId;
    const result = validateP3Matrix(matrix, VALID_PROVENANCE);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p === 'row:caseId-not-string')).toBe(true);
  });
});

describe('markStarted / markResult lifecycle', () => {
  it('started is distinct from final result and persists its reason', () => {
    const matrix = newP3Matrix();
    const started = markStarted(matrix, 'editorial-clean/reels-1080', 'arming listeners');
    const row = started.find((r) => r.caseId === 'editorial-clean/reels-1080');
    expect(row?.phase).toBe('started');
    expect(row?.result).toBe('NOT RUN');
    expect(row?.reason).toBe('arming listeners');
  });

  it('markResult transitions started → FAIL/PASS and preserves reason', () => {
    const matrix = newP3Matrix();
    const started = markStarted(matrix, 'editorial-clean/reels-1080', 'armed');
    const failed = markResult(started, 'editorial-clean/reels-1080', 'FAIL', 'export error');
    const row = failed.find((r) => r.caseId === 'editorial-clean/reels-1080');
    expect(row?.phase).toBe('FAIL');
    expect(row?.result).toBe('FAIL');
    expect(row?.reason).toBe('export error');
  });

  it('full-matrix call: lifecycle preserves all 20 rows, identity, and provenance', () => {
    // Simulates the production call shape used by the P3 spec: pass the
    // ENTIRE matrix to markStarted/markResult, expect a NEW full matrix back.
    const base = attachValidProv(newP3Matrix());
    const started = markStarted(base, 'editorial-clean/reels-1080', 'arming listeners');
    expect(started).toHaveLength(20);
    expect(started).not.toBe(base);
    // Provenance survives the round-trip on every row.
    for (const row of started) {
      expect(row.provenance).toEqual(VALID_PROVENANCE);
    }
    const result = markResult(started, 'editorial-clean/reels-1080', 'PASS', null);
    expect(result).toHaveLength(20);
    expect(result).not.toBe(started);
    for (const row of result) {
      expect(row.provenance).toEqual(VALID_PROVENANCE);
    }
    // Every other row is identical to the input — only the targeted case
    // differs. Proves lifecycle helpers do not silently mutate siblings.
    const targetIdx = result.findIndex((r) => r.caseId === 'editorial-clean/reels-1080');
    for (let i = 0; i < result.length; i += 1) {
      if (i === targetIdx) continue;
      expect(result[i]).toEqual(started[i]);
    }
    expect(result[targetIdx]?.phase).toBe('PASS');
    expect(result[targetIdx]?.result).toBe('PASS');
  });

  it('full-matrix call: FAIL reason is recorded only on the targeted row', () => {
    // Regression: original bug spliced the returned matrix into one row and
    // discarded siblings. This test fails under that bug.
    const base = attachValidProv(newP3Matrix());
    const started = markStarted(base, 'music-pulse/youtube-1080', 'arming');
    const failed = markResult(started, 'music-pulse/youtube-1080', 'FAIL', 'codec unavailable');
    expect(failed).toHaveLength(20);
    for (const row of failed) {
      expect(row.provenance).toEqual(VALID_PROVENANCE);
      if (row.caseId !== 'music-pulse/youtube-1080') {
        // Untouched rows stay NOT RUN — only the targeted row transitions.
        expect(row.result).toBe('NOT RUN');
        expect(row.phase).toBe('NOT RUN');
      } else {
        expect(row.result).toBe('FAIL');
        expect(row.phase).toBe('FAIL');
        expect(row.reason).toBe('codec unavailable');
      }
    }
  });

  it('a PASS row must have phase PASS so a started-but-interrupted case is not PASS', () => {
    const matrix = newP3Matrix();
    const started = markStarted(matrix, 'editorial-clean/reels-1080');
    const row = started.find((r) => r.caseId === 'editorial-clean/reels-1080');
    expect(row?.phase).toBe('started');
    expect(row?.result).not.toBe('PASS');
    const result = validateP3Matrix(attachValidProv(started), VALID_PROVENANCE);
    expect(result.ok).toBe(false);
  });

  it('rejects invalid result argument', () => {
    const matrix = newP3Matrix();
    expect(() => markResult(matrix, 'editorial-clean/reels-1080', 'OK')).toThrow(/invalid result/);
  });

  it('rejects unknown caseId', () => {
    const matrix = newP3Matrix();
    expect(() => markStarted(matrix, 'not-a-case')).toThrow(/unknown caseId/);
  });

  it('is immutable: mutating the original matrix does not affect returned rows', () => {
    const matrix = newP3Matrix();
    const started = markStarted(matrix, 'editorial-clean/reels-1080', 'armed');
    matrix[0].result = 'PASS';
    expect(started[0].result).toBe('NOT RUN');
    expect(started[0].phase).toBe('started');
  });
});

describe('p3Provenance contract', () => {
  it('rejects invalid candidateSha, runId, runAttempt, pass, issuedAt', () => {
    expect(() => p3Provenance({ ...VALID_PROVENANCE, candidateSha: 'short' })).toThrow(
      /candidateSha/,
    );
    expect(() => p3Provenance({ ...VALID_PROVENANCE, runId: 'abc' })).toThrow(/runId/);
    expect(() => p3Provenance({ ...VALID_PROVENANCE, runAttempt: 'x' })).toThrow(/runAttempt/);
    expect(() => p3Provenance({ ...VALID_PROVENANCE, pass: '3' })).toThrow(/pass/);
    expect(() => p3Provenance({ ...VALID_PROVENANCE, issuedAt: 'not-a-date' })).toThrow(/issuedAt/);
  });

  it('accepts only 40-hex candidate, digit run/attempt, 1|2 pass, ISO issuedAt', () => {
    expect(() => p3Provenance(VALID_PROVENANCE)).not.toThrow();
  });
});

describe('P3_RESULTS / P3_CASE_KINDS are the only legal vocabulary', () => {
  it('results are exactly NOT RUN / PASS / FAIL', () => {
    expect([...P3_RESULTS].sort()).toEqual(['FAIL', 'NOT RUN', 'PASS']);
  });
  it('kinds are exactly export / cancel', () => {
    expect([...P3_CASE_KINDS].sort()).toEqual(['cancel', 'export']);
  });
});
