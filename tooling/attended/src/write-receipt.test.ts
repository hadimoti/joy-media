import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'write-receipt.mjs');
const checkout = resolve(here, '../../../');
const CANDIDATE = '6a307ea9be8b012a26cb2793e07da42a6a9e1e04';
const EXE_BYTES = Buffer.from('a stand-in executable for the receipt test\n', 'utf8');
const A1_STEPS = [
  { id: 'sign-in', result: 'pass' },
  { id: 'restart-keeps-session', result: 'pass' },
  { id: 'entitlement-refreshed', result: 'pass' },
  { id: 'offline-boundary-visible', result: 'pass' },
  { id: 'sign-out-clears-credential', result: 'pass' },
  { id: 'token-rejected-after-sign-out', result: 'pass' },
  { id: 'upscale-quality', result: 'pass', measurement: 0.031, unit: 'ssim-margin' },
];

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'write-receipt-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A thresholds file of the test's own, with the upscale value registered or left null. */
function thresholdsFile(ssimMarginOverBicubic: number | null): string {
  const path = join(directory, 'thresholds.json');
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      upscale: { scaleFactor: 4, ssimMarginOverBicubic },
      sessions: {
        G2: {
          defaultLaunches: 30,
          maxGpuProcessExits: 0,
          maxFallbackRelaunches: 0,
          minEncoderSessionsDuringExport: 1,
        },
      },
    })}\n`,
  );
  return path;
}

function writeJson(name: string, value: unknown): string {
  const path = join(directory, name);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
}

interface ReceiptOverrides {
  readonly session?: string;
  readonly out?: string;
  readonly thresholds?: string;
  readonly leakScan?: unknown;
  readonly steps?: unknown;
}

function receiptArgs(overrides: ReceiptOverrides): string[] {
  const exe = join(directory, 'joy-media.exe');
  writeFileSync(exe, EXE_BYTES);
  return [
    '--session',
    overrides.session ?? 'A1',
    '--candidate-sha',
    CANDIDATE,
    '--exe',
    exe,
    '--thresholds',
    overrides.thresholds ?? thresholdsFile(0.02),
    '--started',
    '2026-10-28T10:00:00Z',
    '--finished',
    '2026-10-28T11:00:00Z',
    '--steps',
    writeJson('steps.json', overrides.steps ?? A1_STEPS),
    '--leak-scan',
    writeJson(
      'leak-scan.json',
      overrides.leakScan ?? {
        filesScanned: 12,
        filesSkipped: 0,
        literalCount: 2,
        counts: [0, 0],
        literalFingerprints: ['aaaa', 'bbbb'],
      },
    ),
    '--out',
    overrides.out ?? join(directory, 'receipt.json'),
  ];
}

function argValue(args: string[], name: string): string {
  const value = args[args.indexOf(name) + 1];
  if (value === undefined) throw new Error(`no ${name} in the test arguments`);
  return value;
}

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

describe('attended session receipts', () => {
  it('writes an accepted A1 receipt bound to the candidate, the exe and the thresholds file', () => {
    const args = receiptArgs({});
    const out = argValue(args, '--out');
    const thresholds = argValue(args, '--thresholds');
    expect(run(args).status).toBe(0);

    const receipt = JSON.parse(readFileSync(out, 'utf8'));
    expect(receipt).toMatchObject({
      schema: 'joy-media.attended-receipt.v1',
      session: 'A1',
      candidate: { commitSha: CANDIDATE, exeSha256: sha256(EXE_BYTES) },
      thresholdsSha256: sha256(readFileSync(thresholds)),
      verdict: 'accepted',
      leakScan: { literalCount: 2, hits: 0 },
    });
  });

  it('refuses an A1 receipt while the upscale threshold is still null, and writes nothing', () => {
    const args = receiptArgs({ thresholds: thresholdsFile(null) });
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/upscale\.ssimMarginOverBicubic/u);
    expect(existsSync(argValue(args, '--out'))).toBe(false);
  });

  it('refuses an output inside this repository, and writes nothing', () => {
    const inside = join(checkout, 'test-output', 'attended-receipt-refused.json');
    const result = run(receiptArgs({ out: inside }));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/outside this repository/u);
    expect(existsSync(inside)).toBe(false);
  });

  it('refuses a receipt when the leak scan found a literal, and writes nothing', () => {
    const args = receiptArgs({
      leakScan: {
        filesScanned: 12,
        filesSkipped: 0,
        literalCount: 2,
        counts: [0, 3],
        literalFingerprints: ['aaaa', 'bbbb'],
      },
    });
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/leak scan found 3 occurrence/u);
    expect(existsSync(argValue(args, '--out'))).toBe(false);
  });

  it('refuses a receipt that leaves out a required step, and writes nothing', () => {
    const args = receiptArgs({
      steps: A1_STEPS.filter((step) => step.id !== 'token-rejected-after-sign-out'),
    });
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/token-rejected-after-sign-out/u);
    expect(existsSync(argValue(args, '--out'))).toBe(false);
  });

  it('keeps a failed step and records the verdict as not accepted', () => {
    const args = receiptArgs({
      steps: A1_STEPS.map((step) =>
        step.id === 'token-rejected-after-sign-out' ? { ...step, result: 'fail' } : step,
      ),
    });
    expect(run(args).status).toBe(0);
    const receipt = JSON.parse(readFileSync(argValue(args, '--out'), 'utf8'));
    expect(receipt.verdict).toBe('not-accepted');
    expect(receipt.steps).toHaveLength(A1_STEPS.length);
    expect(
      receipt.steps.find((step: { id: string }) => step.id === 'token-rejected-after-sign-out'),
    ).toMatchObject({ result: 'fail' });
  });

  it('refuses bad usage with exit 2, and an unknown session', () => {
    const args = receiptArgs({});
    expect(run(args.slice(2)).status).toBe(2);
    const result = run(receiptArgs({ session: 'Z9' }));
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--session must be G1, G2 or A1/u);
  });
});
