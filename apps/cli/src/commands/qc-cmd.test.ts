import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli.js';
import { describeFinding, exitCodeForReport, formatQcTime, isFault, QC_USAGE } from './qc-cmd.js';

type Finding = Parameters<typeof describeFinding>[0];

function finding(type: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'qc-finding-1',
    type,
    state: 'measured',
    severity: 'major',
    startUs: 0,
    endUs: 0,
    label: 'A label',
    measured: {},
    fixable: false,
    evidenceIds: [],
    ...overrides,
  } as unknown as Finding;
}

function canRun(tool: string): boolean {
  return spawnSync(tool, ['-version'], { shell: false, stdio: 'ignore' }).status === 0;
}

describe('joy-media qc: pure helpers', () => {
  it('formats times as minutes and tenths of a second', () => {
    expect(formatQcTime(0)).toBe('0:00.0');
    expect(formatQcTime(1_000_000)).toBe('0:01.0');
    expect(formatQcTime(83_500_000)).toBe('1:23.5');
  });

  it('describes a finding with its range, severity and label', () => {
    const text = describeFinding(
      finding('black', { startUs: 1_000_000, endUs: 2_000_000, label: 'Black picture' }),
    );
    expect(text).toBe('[major] black 0:01.0-0:02.0  Black picture');
  });

  it('describes a single-instant finding without a range', () => {
    expect(describeFinding(finding('clipping', { startUs: 5_000_000, endUs: 0 }))).toContain(
      'clipping 0:05.0  ',
    );
  });

  it('treats hard cuts as information, every other type as a fault', () => {
    expect(isFault({ type: 'scene-cut' } as Finding)).toBe(false);
    expect(isFault({ type: 'black' } as Finding)).toBe(true);
    expect(isFault({ type: 'frozen' } as Finding)).toBe(true);
  });

  it('exits 0 for a clean report and with hard cuts only, 1 with a fault', () => {
    const clean = { findings: [] } as never;
    const cutsOnly = { findings: [finding('scene-cut')] } as never;
    const withFault = { findings: [finding('scene-cut'), finding('frozen')] } as never;
    expect(exitCodeForReport(clean)).toBe(0);
    expect(exitCodeForReport(cutsOnly)).toBe(0);
    expect(exitCodeForReport(withFault)).toBe(1);
  });
});

describe('joy-media qc: usage and input errors', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'joy-cli-qc-test-'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('exits 2 with no input file', async () => {
    expect(await runCli(['qc'])).toBe(2);
  });

  it('exits 2 with more than one input file', async () => {
    expect(await runCli(['qc', 'a.mp4', 'b.mp4'])).toBe(2);
  });

  it('exits 1 when the file does not exist', async () => {
    expect(await runCli(['qc', join(homeDir, 'missing.mp4')])).toBe(1);
  });

  it('exits 1 when the input is a folder', async () => {
    expect(await runCli(['qc', homeDir])).toBe(1);
  });

  it('prints one JSON document on stdout for a failure under --json', async () => {
    expect(await runCli(['qc', join(homeDir, 'missing.mp4'), '--json'])).toBe(1);
    const logged = vi
      .mocked(console.log)
      .mock.calls.map((args) => String(args[0]))
      .join('\n');
    expect(JSON.parse(logged)).toMatchObject({ ok: false });
  });

  it('prints the usage line in its own help', async () => {
    expect(await runCli(['help', 'qc'])).toBe(0);
    const logged = vi
      .mocked(console.log)
      .mock.calls.map((args) => String(args[0]))
      .join('\n');
    expect(logged).toContain(QC_USAGE);
  });
});

const hasFfmpeg = canRun('ffmpeg') && canRun('ffprobe');

describe.skipIf(!hasFfmpeg)('joy-media qc on a planted-fault file', () => {
  // 0-1 s moving picture, 1-2 s black, 2-3 s moving, 3-5 s frozen grey. No audio.
  const BLACK_START_US = 1_000_000;
  const FREEZE_START_US = 3_000_000;
  const TOLERANCE_US = 100_000;

  let directory: string;
  let faultFile: string;

  function generateFaultFile(target: string): void {
    const size = 'size=320x240:rate=25';
    const inputs = [
      `testsrc2=${size}:duration=1`,
      `color=c=black:${size}:duration=1`,
      `testsrc2=${size}:duration=1`,
      `color=c=0x808080:${size}:duration=2`,
    ];
    const args = ['-y', '-hide_banner', '-loglevel', 'error'];
    for (const input of inputs) args.push('-f', 'lavfi', '-i', input);
    const segments = inputs.map((_, index) => `[${index}:v]format=yuv420p,setsar=1[v${index}]`);
    const concat = '[v0][v1][v2][v3]concat=n=4:v=1:a=0[v]';
    args.push(
      '-filter_complex',
      `${segments.join(';')};${concat}`,
      '-map',
      '[v]',
      '-c:v',
      'ffv1',
      target,
    );
    const result = spawnSync('ffmpeg', args, { shell: false, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`could not generate the fixture: ${result.stderr}`);
  }

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'joy-cli-qc-fixture-'));
    faultFile = join(directory, 'planted-fault.mkv');
    generateFaultFile(faultFile);
  }, 120_000);

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the black and the frozen part and exits 1', async () => {
    const code = await runCli(['qc', faultFile]);
    expect(code).toBe(1);
    const printed = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]
      .map((args) => String(args[0]))
      .join('\n');
    expect(printed).toMatch(/black/);
    expect(printed).toMatch(/frozen/);
  }, 120_000);

  it('prints a QC report under --json with the black and frozen findings in place', async () => {
    const code = await runCli(['qc', faultFile, '--json']);
    expect(code).toBe(1);
    const stdout = vi
      .mocked(console.log)
      .mock.calls.map((args) => String(args[0]))
      .join('\n');
    const report = JSON.parse(stdout) as {
      version: number;
      modelComprehensionGuaranteed: boolean;
      findings: Array<{ type: string; startUs: number; endUs: number }>;
      technical?: { checksRun: string[] };
    };

    expect(report.version).toBe(1);
    expect(report.modelComprehensionGuaranteed).toBe(false);
    expect(Array.isArray(report.findings)).toBe(true);
    expect(report.technical?.checksRun).toEqual(expect.arrayContaining(['black', 'frozen']));

    const black = report.findings.find((f) => f.type === 'black');
    // The black part is also a still picture, so it is reported as frozen too:
    // look for the frozen finding at the planted grey part.
    const frozen = report.findings.find(
      (f) => f.type === 'frozen' && Math.abs(f.startUs - FREEZE_START_US) <= TOLERANCE_US,
    );
    expect(black).toBeDefined();
    expect(frozen).toBeDefined();
    expect(Math.abs(black!.startUs - BLACK_START_US)).toBeLessThanOrEqual(TOLERANCE_US);
  }, 120_000);
});
