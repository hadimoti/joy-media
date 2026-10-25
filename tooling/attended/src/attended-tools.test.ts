import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReceipt, serializeReceipt } from './receipt.mjs';
import { hasLeak, readLiteralFile, scanForLiterals } from './leak-scan.mjs';

// Synthetic literals only. The owner's real account values never enter the repository or the tests.
const PLANTED = 'self-test-literal-7f3c91';
const SHA40 = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const WINDOW = { startedUtc: '2026-10-26T01:00:00Z', finishedUtc: '2026-10-26T01:30:00Z' };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'attended-leak-scan-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('leak scan', () => {
  it('counts a planted literal in UTF-8 and UTF-16 files, and never returns the literal text', () => {
    mkdirSync(join(root, 'profile'));
    writeFileSync(join(root, 'profile', 'log.txt'), `request ${PLANTED} done`, 'utf8');
    writeFileSync(join(root, 'profile', 'store.bin'), Buffer.from(PLANTED, 'utf16le'));

    const result = scanForLiterals({ roots: [root], literals: [PLANTED] });

    expect(result.counts).toEqual([2]);
    expect(result.filesScanned).toBe(2);
    expect(hasLeak(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(PLANTED);
  });

  it('reports zero for a literal that is absent, and records the scan coverage', () => {
    writeFileSync(join(root, 'clean.txt'), 'nothing sensitive here', 'utf8');
    const result = scanForLiterals({ roots: [root], literals: [PLANTED] });
    expect(result.counts).toEqual([0]);
    expect(result.filesScanned).toBe(1);
    expect(hasLeak(result)).toBe(false);
  });

  it('refuses a scan with no literal, because it would prove nothing', () => {
    expect(() => scanForLiterals({ roots: [root], literals: ['  '] })).toThrow(/No literals/u);
  });

  it('reads one literal per line and skips blank lines', () => {
    const file = join(root, 'literals.txt');
    writeFileSync(file, `first-literal\r\n\nsecond-literal\n`, 'utf8');
    expect(readLiteralFile(file)).toEqual(['first-literal', 'second-literal']);
  });
});

describe('attended receipt', () => {
  const cleanScan = { literalCount: 2, counts: [0, 0], filesScanned: 14 };

  it('accepts a receipt whose steps all pass and whose leak scan is clean', () => {
    const receipt = buildReceipt({
      session: 'G2',
      candidateSha: SHA40,
      exeSha256: DIGEST,
      thresholdsSha256: DIGEST,
      ...WINDOW,
      steps: [
        { id: 'default-launch-01', result: 'pass', measurement: 0, unit: 'gpu-exits' },
        { id: 'export-spec', result: 'pass' },
      ],
      leakScan: cleanScan,
    });
    expect(receipt.verdict).toBe('accepted');
    expect(receipt.leakScan).toEqual({ literalCount: 2, hits: 0, filesScanned: 14 });
    // The receipt carries counts and fingerprints only: nothing shaped like a credential or an address.
    expect(serializeReceipt(receipt)).not.toMatch(/password|api[_-]?key|authorization|token|@/iu);
  });

  it('refuses to write any receipt when the leak scan found a literal', () => {
    expect(() =>
      buildReceipt({
        session: 'A1',
        candidateSha: SHA40,
        exeSha256: DIGEST,
        thresholdsSha256: DIGEST,
        ...WINDOW,
        steps: [{ id: 'sign-in', result: 'pass' }],
        leakScan: { literalCount: 2, counts: [0, 1], filesScanned: 14 },
      }),
    ).toThrow(/receipt was not written/u);
  });

  it('keeps a failed step in the record as not-accepted instead of dropping it', () => {
    const receipt = buildReceipt({
      session: 'G1',
      candidateSha: SHA40,
      exeSha256: DIGEST,
      thresholdsSha256: DIGEST,
      ...WINDOW,
      steps: [
        { id: 'inventory', result: 'pass' },
        { id: 'default-launch-02', result: 'fail', measurement: 1, unit: 'gpu-exits' },
      ],
      leakScan: cleanScan,
    });
    expect(receipt.verdict).toBe('not-accepted');
    expect(receipt.steps.map((step) => step.id)).toEqual(['inventory', 'default-launch-02']);
  });

  it('refuses an unknown session, malformed identifiers, and a window that ends before it starts', () => {
    const base = {
      session: 'G2',
      candidateSha: SHA40,
      exeSha256: DIGEST,
      thresholdsSha256: DIGEST,
      ...WINDOW,
      steps: [{ id: 'step', result: 'pass' as const }],
      leakScan: cleanScan,
    };
    expect(() => buildReceipt({ ...base, session: 'Z9' })).toThrow(/Unknown attended session/u);
    expect(() => buildReceipt({ ...base, candidateSha: 'ABC' })).toThrow(/full lowercase commit/u);
    expect(() => buildReceipt({ ...base, exeSha256: 'not-a-digest' })).toThrow(/exe digest/u);
    expect(() =>
      buildReceipt({
        ...base,
        startedUtc: '2026-10-26T02:00:00Z',
        finishedUtc: '2026-10-26T01:00:00Z',
      }),
    ).toThrow(/finish after the start/u);
  });

  it('refuses a step that carries a field the receipt does not allow', () => {
    expect(() =>
      buildReceipt({
        session: 'A1',
        candidateSha: SHA40,
        exeSha256: DIGEST,
        thresholdsSha256: DIGEST,
        ...WINDOW,
        steps: [{ id: 'sign-in', result: 'pass', account: 'someone' } as never],
        leakScan: cleanScan,
      }),
    ).toThrow(/Step field "account" is not allowed/u);
  });
});
