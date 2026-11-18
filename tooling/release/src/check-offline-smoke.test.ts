import { describe, expect, it } from 'vitest';
import {
  checkOfflineSmoke,
  digestFor,
  parseOfflineSmokeArgs,
  type OfflineSmokeCheckArgs,
} from './check-offline-smoke.ts';
import { OFFLINE_SMOKE_SCHEMA } from './offline-smoke-receipt.ts';

const CANDIDATE = 'a'.repeat(40);
const ARTIFACT = 'joy-media-windows-x64-v1.1.0.zip';
const DIGEST = 'b'.repeat(64);
const SUMS = `${'c'.repeat(64)}  joy-media.exe\n${DIGEST} *${ARTIFACT}\n`;
const ARGS: OfflineSmokeCheckArgs = {
  candidate: CANDIDATE,
  receiptPath: 'receipts/offline-smoke.json',
  sumsPath: 'receipts/SHA256SUMS.txt',
  artifact: ARTIFACT,
  windowStart: '2026-11-09T00:00:00Z',
  windowEnd: '2026-11-09T06:00:00Z',
};

function receipt(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: OFFLINE_SMOKE_SCHEMA,
    candidateSha: CANDIDATE,
    workflowSha: 'd'.repeat(40),
    runId: '7',
    attempt: 1,
    artifact: { name: ARTIFACT, sha256: DIGEST },
    builtAt: '2026-11-09T01:00:00Z',
    startedAt: '2026-11-09T02:00:00Z',
    finishedAt: '2026-11-09T02:05:00Z',
    steps: ['launch', 'import', 'export', 'doctor', 'render'].map((id) => ({ id, result: 'pass' })),
    egress: {
      main: 0,
      renderer: 0,
      worker: 0,
      cli: 0,
      netLogSha256: 'e'.repeat(64),
      reason: 'Sandbox networking was disabled and no adapter was present; zero by construction.',
    },
    network: {
      networkingDisabled: true,
      adapterPresent: false,
      adapterCount: 0,
      reason: 'Windows Sandbox networking was disabled; adapter enumeration returned zero.',
    },
    verdict: 'pass',
    ...overrides,
  });
}

function io(files: Record<string, string | undefined>) {
  return { readText: (path: string) => files[path] };
}

describe('attended offline-smoke check', () => {
  it('reads the artifact digest from the SHA256SUMS.txt line for that artifact', () => {
    expect(digestFor(SUMS, ARTIFACT)).toBe(DIGEST);
    expect(digestFor(SUMS, 'missing.zip')).toBeUndefined();
  });

  it('accepts a receipt that binds to the candidate, the artifact digest and the window', () => {
    const outcome = checkOfflineSmoke(
      ARGS,
      io({ [ARGS.sumsPath]: SUMS, [ARGS.receiptPath]: receipt() }),
    );
    expect(outcome).toEqual({ ok: true, reasons: [] });
  });

  it('accepts a hand-written five-step receipt with offline isolation evidence', () => {
    const handWrittenReceipt = JSON.stringify({
      schema: OFFLINE_SMOKE_SCHEMA,
      candidateSha: CANDIDATE,
      workflowSha: 'd'.repeat(40),
      runId: 'hand-written-1',
      attempt: 1,
      artifact: { name: ARTIFACT, sha256: DIGEST },
      builtAt: '2026-11-09T01:00:00Z',
      startedAt: '2026-11-09T02:00:00Z',
      finishedAt: '2026-11-09T02:05:00Z',
      steps: [
        { id: 'launch', result: 'pass' },
        { id: 'import', result: 'pass' },
        { id: 'export', result: 'pass' },
        { id: 'doctor', result: 'pass' },
        { id: 'render', result: 'pass' },
      ],
      egress: {
        main: 0,
        renderer: 0,
        worker: 0,
        cli: 0,
        netLogSha256: 'e'.repeat(64),
        reason: 'Zero by construction: Sandbox networking is disabled and no adapter is present.',
      },
      network: {
        networkingDisabled: true,
        adapterPresent: false,
        adapterCount: 0,
        reason: 'Get-NetAdapter returned no adapters with Networking=Disable.',
      },
      verdict: 'pass',
    });

    expect(
      checkOfflineSmoke(
        ARGS,
        io({ [ARGS.sumsPath]: SUMS, [ARGS.receiptPath]: handWrittenReceipt }),
      ),
    ).toEqual({ ok: true, reasons: [] });
  });

  it.each([
    [
      'adapter present',
      {
        network: {
          networkingDisabled: true,
          adapterPresent: true,
          adapterCount: 1,
          reason: 'adapter found',
        },
      },
      /network adapter was present/u,
    ],
    [
      'missing render step',
      { steps: ['launch', 'import', 'export', 'doctor'].map((id) => ({ id, result: 'pass' })) },
      /step render is missing/u,
    ],
    [
      'non-zero CLI egress',
      {
        egress: {
          main: 0,
          renderer: 0,
          worker: 0,
          cli: 1,
          netLogSha256: 'e'.repeat(64),
          reason: 'not isolated',
        },
      },
      /egress\.cli is not zero/u,
    ],
    [
      'wrong schema',
      { schema: 'joy-media.offline-smoke/0' },
      /schema is not joy-media\.offline-smoke\/1/u,
    ],
  ])('refuses a receipt with %s', (_name, overrides, reason) => {
    const outcome = checkOfflineSmoke(
      ARGS,
      io({ [ARGS.sumsPath]: SUMS, [ARGS.receiptPath]: receipt(overrides) }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reasons.join('\n')).toMatch(reason);
  });

  it('refuses when the SHA256SUMS.txt file is missing', () => {
    const outcome = checkOfflineSmoke(ARGS, io({ [ARGS.receiptPath]: receipt() }));
    expect(outcome.ok).toBe(false);
    expect(outcome.reasons).toEqual(['SHA256SUMS.txt is missing for the candidate']);
  });

  it('refuses when SHA256SUMS.txt has no line for the artifact, so the digest cannot be bound', () => {
    const outcome = checkOfflineSmoke(
      { ...ARGS, artifact: 'other.zip' },
      io({ [ARGS.sumsPath]: SUMS, [ARGS.receiptPath]: receipt() }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reasons).toEqual(['SHA256SUMS.txt has no line for other.zip']);
  });

  it('refuses a receipt whose artifact digest is not the SHA256SUMS line', () => {
    const outcome = checkOfflineSmoke(
      ARGS,
      io({
        [ARGS.sumsPath]: SUMS,
        [ARGS.receiptPath]: receipt({ artifact: { name: ARTIFACT, sha256: 'f'.repeat(64) } }),
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reasons.join(' ')).toMatch(/SHA256SUMS\.txt line/u);
  });

  it('parses every flag, and refuses a missing, unknown or unpaired one', () => {
    const argv = [
      '--candidate',
      CANDIDATE,
      '--receipt',
      'r.json',
      '--sums',
      's.txt',
      '--artifact',
      ARTIFACT,
      '--window-start',
      '2026-11-09T00:00:00Z',
      '--window-end',
      '2026-11-09T06:00:00Z',
    ];
    expect(parseOfflineSmokeArgs(argv)).toEqual({
      candidate: CANDIDATE,
      receiptPath: 'r.json',
      sumsPath: 's.txt',
      artifact: ARTIFACT,
      windowStart: '2026-11-09T00:00:00Z',
      windowEnd: '2026-11-09T06:00:00Z',
    });
    expect(parseOfflineSmokeArgs(argv.slice(2))).toMatch(/missing --candidate/u);
    expect(parseOfflineSmokeArgs(['--candidate'])).toMatch(/expected --name value pairs/u);
    expect(parseOfflineSmokeArgs([...argv, '--extra', 'x'])).toMatch(/unknown option/u);
    expect(parseOfflineSmokeArgs(argv.slice(0, 4))).toMatch(/missing --/u);
  });
});
