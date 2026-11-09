import { describe, expect, it } from 'vitest';
import {
  OFFLINE_SMOKE_SCHEMA,
  type OfflineSmokeExpectation,
  validateOfflineSmokeReceipt,
  validateOfflineSmokeReceiptText,
} from './offline-smoke-receipt.ts';

const CANDIDATE = 'a'.repeat(40);
const ARTIFACT_NAME = 'joy-media-windows-x64-v1.1.0.zip';
const ARTIFACT_SHA = 'b'.repeat(64);
const expected: OfflineSmokeExpectation = {
  candidateSha: CANDIDATE,
  artifactName: ARTIFACT_NAME,
  artifactSha256: ARTIFACT_SHA,
  runWindow: { start: '2026-11-09T00:00:00Z', end: '2026-11-09T06:00:00Z' },
};

function baseline(): Record<string, unknown> {
  return {
    schema: OFFLINE_SMOKE_SCHEMA,
    candidateSha: CANDIDATE,
    workflowSha: 'c'.repeat(40),
    runId: '424242',
    attempt: 1,
    artifact: { name: ARTIFACT_NAME, sha256: ARTIFACT_SHA },
    builtAt: '2026-11-09T01:00:00Z',
    startedAt: '2026-11-09T02:00:00Z',
    finishedAt: '2026-11-09T02:10:00Z',
    steps: [
      { id: 'launch', result: 'pass' },
      { id: 'open', result: 'pass' },
      { id: 'export', result: 'pass' },
      { id: 'cli', result: 'pass' },
    ],
    egress: { main: 0, renderer: 0, worker: 0, cli: 0, netLogSha256: 'd'.repeat(64) },
    verdict: 'pass',
  };
}

describe('offline-smoke receipt (joy-media.offline-smoke/1)', () => {
  it('accepts a receipt that binds to the candidate, the artifact and the run, with zero egress', () => {
    expect(validateOfflineSmokeReceipt(baseline(), expected)).toEqual({ ok: true, reasons: [] });
  });

  it.each<[string, (receipt: Record<string, unknown>) => void, RegExp]>([
    ['another schema', (r) => (r.schema = 'joy-media.offline-smoke/0'), /schema is not/],
    ['another candidate', (r) => (r.candidateSha = 'e'.repeat(40)), /candidateSha/],
    ['a malformed workflow SHA', (r) => (r.workflowSha = 'not-a-sha'), /workflowSha/],
    ['no run id', (r) => (r.runId = ''), /runId is missing/],
    ['a second attempt', (r) => (r.attempt = 2), /attempt is not 1/],
    [
      'another artifact name',
      (r) => (r.artifact = { name: 'other.zip', sha256: ARTIFACT_SHA }),
      /artifact.name/,
    ],
    [
      'an artifact digest that is not the SHA256SUMS line',
      (r) => (r.artifact = { name: ARTIFACT_NAME, sha256: 'f'.repeat(64) }),
      /artifact.sha256/,
    ],
    [
      'a non-UTC timestamp',
      (r) => (r.startedAt = '2026-11-09 02:00:00'),
      /startedAt is not a UTC timestamp/,
    ],
    ['timestamps out of order', (r) => (r.builtAt = '2026-11-09T03:00:00Z'), /out of order/],
    [
      'a start before the run window',
      (r) => (r.startedAt = '2026-11-08T23:00:00Z'),
      /startedAt is outside the run window/,
    ],
    [
      'a finish after the run window',
      (r) => (r.finishedAt = '2026-11-09T07:00:00Z'),
      /finishedAt is outside the run window/,
    ],
    [
      'a failed step',
      (r) =>
        (r.steps = [
          { id: 'launch', result: 'pass' },
          { id: 'open', result: 'fail' },
          { id: 'export', result: 'pass' },
          { id: 'cli', result: 'pass' },
        ]),
      /step open did not pass/,
    ],
    [
      'a missing step',
      (r) =>
        (r.steps = [
          { id: 'launch', result: 'pass' },
          { id: 'open', result: 'pass' },
          { id: 'export', result: 'pass' },
        ]),
      /step cli is missing/,
    ],
    [
      'a repeated step',
      (r) =>
        (r.steps = [
          { id: 'launch', result: 'pass' },
          { id: 'launch', result: 'pass' },
          { id: 'open', result: 'pass' },
          { id: 'export', result: 'pass' },
          { id: 'cli', result: 'pass' },
        ]),
      /step launch appears more than once/,
    ],
    [
      'an unknown step',
      (r) =>
        (r.steps = [
          { id: 'launch', result: 'pass' },
          { id: 'open', result: 'pass' },
          { id: 'export', result: 'pass' },
          { id: 'cli', result: 'pass' },
          { id: 'stretch', result: 'pass' },
        ]),
      /unknown id/,
    ],
    [
      'egress from the renderer',
      (r) => (r.egress = { main: 0, renderer: 3, worker: 0, cli: 0, netLogSha256: 'd'.repeat(64) }),
      /egress.renderer is not zero/,
    ],
    [
      'egress from the CLI',
      (r) => (r.egress = { main: 0, renderer: 0, worker: 0, cli: 1, netLogSha256: 'd'.repeat(64) }),
      /egress.cli is not zero/,
    ],
    [
      'no net log digest',
      (r) => (r.egress = { main: 0, renderer: 0, worker: 0, cli: 0 }),
      /netLogSha256/,
    ],
    ['a fail verdict', (r) => (r.verdict = 'fail'), /verdict is fail/],
    ['no verdict', (r) => delete r.verdict, /verdict is not pass/],
  ])('refuses %s', (_name, mutate, reason) => {
    const receipt = baseline();
    mutate(receipt);
    const result = validateOfflineSmokeReceipt(receipt, expected);
    expect(result.ok).toBe(false);
    expect(result.reasons.join('\n')).toMatch(reason);
  });

  it('refuses a receipt that is not an object', () => {
    expect(validateOfflineSmokeReceipt(['not', 'an', 'object'], expected)).toEqual({
      ok: false,
      reasons: ['the receipt is not a JSON object'],
    });
  });

  it('refuses a missing receipt file, one that is not JSON, and one that is valid', () => {
    expect(validateOfflineSmokeReceiptText(undefined, expected).reasons).toEqual([
      'the offline-smoke receipt is missing',
    ]);
    expect(validateOfflineSmokeReceiptText('{ not json', expected).reasons).toEqual([
      'the offline-smoke receipt is not valid JSON',
    ]);
    expect(validateOfflineSmokeReceiptText(JSON.stringify(baseline()), expected).ok).toBe(true);
  });
});
