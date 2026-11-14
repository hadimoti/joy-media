import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QC_THRESHOLDS,
  analysePicture,
  buildQcReport,
  parseAstatsOverall,
  parseBlackdetect,
  parseEbur128Summary,
  parseFreezedetect,
  parseMediaQcPayload,
  parseProbe,
  parseScdet,
  parseSignalstats,
  parseSilencedetect,
  qcFindings,
  runMediaQc,
  runProcess,
  type QcMeasurements,
  type QcSignalFrame,
} from './media-qc.js';

const SECOND = 1_000_000;

describe('ffmpeg output parsers', () => {
  it('reads blackdetect runs in microseconds and keeps them inside the file', () => {
    const text = [
      '[blackdetect @ 000001f0a8b3c340] black_start:2 black_end:3 black_duration:1',
      '[blackdetect @ 000001f0a8b3c340] black_start:7.5 black_end:9.25 black_duration:1.75',
    ].join('\n');
    expect(parseBlackdetect(text, 8 * SECOND)).toEqual([
      { startUs: 2 * SECOND, endUs: 3 * SECOND },
      { startUs: 7_500_000, endUs: 8 * SECOND },
    ]);
    expect(parseBlackdetect('no black here', 8 * SECOND)).toEqual([]);
  });

  it('reads freezedetect runs, closes an open freeze at the end, and drops it when the pass was cut short', () => {
    const closed = [
      '[freezedetect @ 0000023b5e8f0a40] lavfi.freezedetect.freeze_start: 5',
      '[freezedetect @ 0000023b5e8f0a40] lavfi.freezedetect.freeze_duration: 2',
      '[freezedetect @ 0000023b5e8f0a40] lavfi.freezedetect.freeze_end: 7',
    ].join('\n');
    expect(parseFreezedetect(closed, 8 * SECOND, 8 * SECOND)).toEqual([
      { startUs: 5 * SECOND, endUs: 7 * SECOND },
    ]);
    const open = '[freezedetect @ 0000023b5e8f0a40] lavfi.freezedetect.freeze_start: 6.5';
    expect(parseFreezedetect(open, 8 * SECOND, 8 * SECOND)).toEqual([
      { startUs: 6_500_000, endUs: 8 * SECOND },
    ]);
    expect(parseFreezedetect(open, 8 * SECOND, undefined)).toEqual([]);
  });

  it('reads scdet scores and times', () => {
    const text =
      '[scdet @ 0000000a] lavfi.scd.score: 45.211, lavfi.scd.time: 2\n[scdet @ 0000000a] lavfi.scd.score: 12.5, lavfi.scd.time: 5.04';
    expect(parseScdet(text)).toEqual([
      { timeUs: 2 * SECOND, score: 45.211 },
      { timeUs: 5_040_000, score: 12.5 },
    ]);
  });

  it('reads silence runs, clamps a tiny negative start, and closes an open run at the end', () => {
    const text = [
      '[silencedetect @ 0000000b] silence_start: -0.0000208333',
      '[silencedetect @ 0000000b] silence_end: 1.5 | silence_duration: 1.5',
      '[silencedetect @ 0000000b] silence_start: 6',
      '[silencedetect @ 0000000b] silence_end: 8 | silence_duration: 2',
      '[silencedetect @ 0000000b] silence_start: 9',
    ].join('\n');
    expect(parseSilencedetect(text, 10 * SECOND, 10 * SECOND)).toEqual([
      { startUs: 0, endUs: 1_500_000 },
      { startUs: 6 * SECOND, endUs: 8 * SECOND },
      { startUs: 9 * SECOND, endUs: 10 * SECOND },
    ]);
    expect(parseSilencedetect(text, 10 * SECOND, undefined)).toHaveLength(2);
  });

  it('reads the ebur128 summary and treats -inf as no value', () => {
    const summary = [
      '[Parsed_ebur128_0 @ 0000000c] Summary:',
      '',
      '  Integrated loudness:',
      '    I:         -23.4 LUFS',
      '    Threshold: -33.5 LUFS',
      '',
      '  Loudness range:',
      '    LRA:         6.2 LU',
      '    Threshold: -43.5 LUFS',
      '    LRA low:   -27.8 LUFS',
      '    LRA high:  -21.6 LUFS',
      '',
      '  True peak:',
      '    Peak:       -1.2 dBFS',
    ].join('\n');
    expect(parseEbur128Summary(summary)).toEqual({
      integratedLufs: -23.4,
      loudnessRangeLu: 6.2,
      truePeakDbfs: -1.2,
    });
    expect(parseEbur128Summary(summary.replace('-23.4 LUFS', '-inf LUFS'))).toMatchObject({
      integratedLufs: null,
    });
    expect(parseEbur128Summary('no summary printed')).toBeUndefined();
  });

  it('reads the Overall block of astats, not a channel block', () => {
    const text = [
      '[Parsed_astats_2 @ 0000000d] Channel: 1',
      '[Parsed_astats_2 @ 0000000d] Peak level dB: -2.5',
      '[Parsed_astats_2 @ 0000000d] Number of samples: 44100',
      '[Parsed_astats_2 @ 0000000d] Overall',
      '[Parsed_astats_2 @ 0000000d] DC offset: 0.000000',
      '[Parsed_astats_2 @ 0000000d] Peak level dB: -0.010000',
      '[Parsed_astats_2 @ 0000000d] Peak count: 12',
      '[Parsed_astats_2 @ 0000000d] Number of samples: 88200',
    ].join('\n');
    expect(parseAstatsOverall(text)).toEqual({ peakDb: -0.01, peakCount: 12, samples: 88200 });
    expect(parseAstatsOverall('nothing')).toBeUndefined();
  });

  it('reads signalstats frames from the stdout form and from the log form', () => {
    const stdoutForm = [
      'frame:0    pts:0       pts_time:0',
      'lavfi.signalstats.YMIN=16',
      'lavfi.signalstats.YAVG=120.5',
      'lavfi.signalstats.YMAX=235',
      'lavfi.signalstats.UAVG=128.1',
      'lavfi.signalstats.VAVG=127.9',
      'frame:1    pts:1       pts_time:0.5',
      'lavfi.signalstats.YAVG=30',
      'lavfi.signalstats.YMAX=90',
      'lavfi.signalstats.UAVG=140',
      'lavfi.signalstats.VAVG=110',
    ].join('\n');
    const expected = [
      { timeUs: 0, yavg: 120.5, ymax: 235, uavg: 128.1, vavg: 127.9 },
      { timeUs: 500_000, yavg: 30, ymax: 90, uavg: 140, vavg: 110 },
    ];
    expect(parseSignalstats(stdoutForm)).toEqual(expected);
    const logForm = stdoutForm
      .split('\n')
      .map((line) => `[Parsed_metadata_2 @ 0000000e] ${line}`)
      .join('\n');
    expect(parseSignalstats(logForm)).toEqual(expected);
  });

  it('reads ffprobe json and does not count cover art as video', () => {
    expect(
      parseProbe(
        JSON.stringify({
          streams: [
            { codec_type: 'video', disposition: { attached_pic: 1 } },
            { codec_type: 'audio', duration: '12.5' },
          ],
          format: { duration: '12.480000' },
        }),
      ),
    ).toEqual({ durationUs: 12_480_000, hasVideo: false, hasAudio: true });
    expect(
      parseProbe(
        JSON.stringify({
          streams: [{ codec_type: 'video', disposition: { attached_pic: 0 }, duration: '3' }],
          format: {},
        }),
      ),
    ).toEqual({ durationUs: 3 * SECOND, hasVideo: true, hasAudio: false });
    expect(() => parseProbe('not json')).toThrow('unreadable');
  });
});

describe('picture analysis', () => {
  const frame = (
    seconds: number,
    yavg: number,
    ymax = 235,
    uavg = 128,
    vavg = 128,
  ): QcSignalFrame => ({
    timeUs: seconds * SECOND,
    yavg,
    ymax,
    uavg,
    vavg,
  });

  it('finds a dark run, ignores black frames, and measures a neutral picture as no cast', () => {
    const frames = [
      frame(0, 120),
      frame(1, 20, 20), // black: not an exposure fault
      frame(2, 30, 90),
      frame(3, 31, 90),
      frame(4, 32, 90),
      frame(5, 120),
    ];
    const analysis = analysePicture(frames, SECOND, DEFAULT_QC_THRESHOLDS);
    expect(analysis.exposureRuns).toEqual([
      { kind: 'dark', startUs: 2 * SECOND, endUs: 5 * SECOND, meanLuma: 31 },
    ]);
    expect(analysis.sampledFrames).toBe(5);
    expect(analysis.medianChromaDistance).toBe(0);
  });

  it('drops a run shorter than the minimum and finds a bright run', () => {
    // Frames half a second apart: the bright run lasts 2.5 s, the single dark frame only 0.5 s.
    const analysis = analysePicture(
      [frame(0, 250, 255), frame(1, 252, 255), frame(2, 254, 255), frame(3, 120), frame(4, 30, 90)],
      500_000,
      DEFAULT_QC_THRESHOLDS,
    );
    expect(analysis.exposureRuns).toEqual([
      { kind: 'bright', startUs: 0, endUs: 2_500_000, meanLuma: 252 },
    ]);
  });

  it('reports a colour cast from the median chroma distance', () => {
    const cast = analysePicture(
      [frame(0, 120, 235, 160, 128), frame(1, 120, 235, 162, 128), frame(2, 120, 235, 161, 128)],
      SECOND,
      DEFAULT_QC_THRESHOLDS,
    );
    expect(cast.medianChromaDistance).toBeCloseTo(33, 5);
  });
});

function measurements(overrides: Partial<QcMeasurements> = {}): QcMeasurements {
  return {
    durationUs: 10 * SECOND,
    hasVideo: true,
    hasAudio: true,
    checksRun: ['black', 'frozen'],
    incomplete: false,
    truncated: [],
    elapsedMs: 12,
    ...overrides,
  };
}

describe('QC report', () => {
  const base = {
    reportId: 'qc-report-job-1',
    assetId: 'asset-1',
    createdAt: '2026-11-14T00:00:00.000Z',
    thresholds: DEFAULT_QC_THRESHOLDS,
  };

  it('turns measurements into sorted, numbered, measured findings with plain labels', () => {
    const report = buildQcReport({
      ...base,
      measurements: measurements({
        black: [{ startUs: 4 * SECOND, endUs: 5_500_000 }],
        frozen: [{ startUs: 1 * SECOND, endUs: 7 * SECOND }],
        silence: [{ startUs: 8 * SECOND, endUs: 10 * SECOND }],
        sceneCuts: [{ timeUs: 4 * SECOND, score: 40 }],
        loudness: { integratedLufs: -33, loudnessRangeLu: 4, truePeakDbfs: -6 },
        audioStats: { peakDb: -0.05, peakCount: 4, samples: 1000 },
      }),
    });
    expect(report.version).toBe(1);
    expect(report.target).toEqual({ kind: 'file', assetId: 'asset-1' });
    expect(report.run).toEqual({
      layer1: true,
      layer2: false,
      modelId: null,
      framesSent: 0,
      framesSkipped: 0,
    });
    expect(report.modelComprehensionGuaranteed).toBe(false);
    expect(report.coverage).toEqual({
      completeSourceCoverage: true,
      sampledRanges: [{ startUs: 0, endUs: 10 * SECOND }],
      unsampledRanges: [],
    });
    expect(report.findings.map((finding) => finding.id)).toEqual(
      report.findings.map((_, index) => `qc-finding-${index + 1}`),
    );
    const starts = report.findings.map((finding) => finding.startUs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(report.findings.every((finding) => finding.state === 'measured')).toBe(true);

    const black = report.findings.find((finding) => finding.type === 'black');
    expect(black).toMatchObject({
      severity: 'minor',
      startUs: 4 * SECOND,
      endUs: 5_500_000,
      measured: { blackDurationUs: 1_500_000 },
      fixable: false,
      label: 'Black picture for 1.5 s at 00:04.',
    });
    expect(report.findings.find((finding) => finding.type === 'frozen')).toMatchObject({
      severity: 'major',
      fixable: false,
    });
    expect(report.findings.find((finding) => finding.type === 'silence')).toMatchObject({
      severity: 'minor',
      fixable: true,
    });
    expect(report.findings.find((finding) => finding.type === 'loudness')).toMatchObject({
      severity: 'major',
      fixable: true,
      measured: { integratedLufs: -33 },
    });
    expect(report.findings.find((finding) => finding.type === 'clipping')).toMatchObject({
      fixable: true,
      measured: { peakDb: -0.05, peakCount: 4 },
    });
    expect(report.findings.find((finding) => finding.type === 'scene-cut')).toMatchObject({
      startUs: 4 * SECOND,
      endUs: 4 * SECOND,
    });
    expect(report.technical?.thresholds).toEqual(DEFAULT_QC_THRESHOLDS);
    expect(report.technical?.checksRun).toEqual(['black', 'frozen']);
  });

  it('reports no loudness or clipping fault for a healthy mix, but keeps the numbers', () => {
    const report = buildQcReport({
      ...base,
      measurements: measurements({
        loudness: { integratedLufs: -16, loudnessRangeLu: 5, truePeakDbfs: -3 },
        audioStats: { peakDb: -3, peakCount: 1, samples: 1000 },
      }),
    });
    expect(report.findings).toEqual([]);
    expect(report.technical?.loudness).toEqual({
      integratedLufs: -16,
      loudnessRangeLu: 5,
      truePeakDbfs: -3,
    });
    expect(report.technical?.audioPeakDb).toBe(-3);
  });

  it('says so when a pass was cut short: coverage is not complete and the reason is listed', () => {
    const report = buildQcReport({
      ...base,
      measurements: measurements({
        incomplete: true,
        truncated: ['the video check stopped at the time limit; its results are partial'],
      }),
    });
    expect(report.coverage).toEqual({
      completeSourceCoverage: false,
      sampledRanges: [],
      unsampledRanges: [{ startUs: 0, endUs: 10 * SECOND }],
    });
    expect(report.technical?.truncated).toEqual([
      'the video check stopped at the time limit; its results are partial',
    ]);
  });

  it('keeps the report under its size cap by dropping scene cuts first, and says so', () => {
    const cuts = Array.from({ length: 800 }, (_, index) => ({
      timeUs: index * 1000,
      score: 20 + (index % 7),
    }));
    const thresholds = { ...DEFAULT_QC_THRESHOLDS, maxSceneCuts: 1000 };
    const report = buildQcReport({
      ...base,
      thresholds,
      maxReportBytes: 40_000,
      measurements: measurements({
        sceneCuts: cuts,
        black: [{ startUs: 0, endUs: 4 * SECOND }],
      }),
    });
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(40_000);
    expect(report.findings.some((finding) => finding.type === 'black')).toBe(true);
    expect(report.findings.filter((finding) => finding.type === 'scene-cut').length).toBeLessThan(
      800,
    );
    expect(report.technical?.truncated.some((reason) => /not listed/.test(reason))).toBe(true);
  });

  it('lists no more hard cuts than the setting and says how many were left out', () => {
    const cuts = Array.from({ length: 10 }, (_, index) => ({ timeUs: index * SECOND, score: 30 }));
    const report = buildQcReport({
      ...base,
      thresholds: { ...DEFAULT_QC_THRESHOLDS, maxSceneCuts: 4 },
      measurements: measurements({ sceneCuts: cuts }),
    });
    expect(report.findings.filter((finding) => finding.type === 'scene-cut')).toHaveLength(4);
    expect(report.technical?.truncated).toEqual(['6 hard cuts were not listed (limit 4)']);
  });

  it('flags a colour cast and an exposure run from the picture analysis', () => {
    const findings = qcFindings(
      measurements({
        picture: {
          sampledFrames: 10,
          meanLuma: 40,
          medianChromaDistance: 30,
          exposureRuns: [{ kind: 'dark', startUs: 2 * SECOND, endUs: 9 * SECOND, meanLuma: 31.04 }],
        },
      }),
      DEFAULT_QC_THRESHOLDS,
    );
    expect(findings.map((finding) => finding.type)).toEqual(['colour-cast', 'exposure']);
    expect(findings.find((finding) => finding.type === 'exposure')).toMatchObject({
      severity: 'major',
      label: 'Too dark for 7.0 s at 00:02.',
      measured: { meanLuma: 31, kind: 'dark' },
    });
    expect(findings.find((finding) => finding.type === 'colour-cast')?.severity).toBe('major');
  });
});

describe('job payload', () => {
  it('runs every check with the defaults when there is no payload', () => {
    for (const payload of [undefined, null, {}]) {
      const parsed = parseMediaQcPayload(payload);
      expect(parsed.checks.size).toBe(8);
      expect(parsed.thresholds).toEqual(DEFAULT_QC_THRESHOLDS);
      expect(parsed.maxRunMs).toBe(10 * 60 * 1000);
    }
  });

  it('accepts a subset of checks, a threshold override and a lower time cap, and caps a higher one', () => {
    const parsed = parseMediaQcPayload({
      schemaVersion: 1,
      checks: ['black', 'frozen'],
      thresholds: { blackMinDurationSec: 0.5 },
      maxRunMs: 5_000,
    });
    expect([...parsed.checks]).toEqual(['black', 'frozen']);
    expect(parsed.thresholds.blackMinDurationSec).toBe(0.5);
    expect(parsed.thresholds.freezeMinDurationSec).toBe(1);
    expect(parsed.maxRunMs).toBe(5_000);
    expect(parseMediaQcPayload({ maxRunMs: 99 * 60 * 1000 }).maxRunMs).toBe(30 * 60 * 1000);
  });

  it('refuses an unknown check, an unknown or out-of-range threshold, and a bad shape', () => {
    expect(() => parseMediaQcPayload({ checks: ['nonsense'] })).toThrow('unknown check');
    expect(() => parseMediaQcPayload({ checks: [] })).toThrow('non-empty');
    expect(() => parseMediaQcPayload({ thresholds: { nope: 1 } })).toThrow('unknown setting');
    expect(() => parseMediaQcPayload({ thresholds: { silenceDb: 5 } })).toThrow('silenceDb');
    expect(() => parseMediaQcPayload({ thresholds: { silenceDb: Number.NaN } })).toThrow(
      'silenceDb',
    );
    expect(() => parseMediaQcPayload({ schemaVersion: 2 })).toThrow('schemaVersion');
    expect(() => parseMediaQcPayload([])).toThrow('JSON object');
    expect(() => parseMediaQcPayload({ maxRunMs: 5 })).toThrow('maxRunMs');
  });
});

describe('bounded process runner', () => {
  const never = () => false;
  const limits = {
    cancelled: never,
    timeoutMs: 20_000,
    stdoutHeadBytes: 1000,
    stderrHeadBytes: 100,
    stderrTailBytes: 100,
  };

  it('captures output and reports a clean exit', async () => {
    const outcome = await runProcess(
      process.execPath,
      ['-e', "process.stdout.write('out'); process.stderr.write('err')"],
      limits,
    );
    expect(outcome).toMatchObject({
      state: 'completed',
      exitCode: 0,
      stdout: 'out',
      stderr: 'err',
    });
    expect(outcome.truncated).toBe(false);
  });

  it('reports a non-zero exit as failed, and a missing program as failed', async () => {
    const failed = await runProcess(process.execPath, ['-e', 'process.exit(3)'], limits);
    expect(failed).toMatchObject({ state: 'failed', exitCode: 3 });
    const missing = await runProcess('joy-media-no-such-program', [], limits);
    expect(missing.state).toBe('failed');
  });

  it('stops a process that runs past its time cap', async () => {
    const started = Date.now();
    const outcome = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      ...limits,
      timeoutMs: 300,
    });
    expect(outcome.state).toBe('timed-out');
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('stops a process when the job is cancelled', async () => {
    let cancel = false;
    setTimeout(() => {
      cancel = true;
    }, 200);
    const outcome = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      ...limits,
      cancelled: () => cancel,
    });
    expect(outcome.state).toBe('cancelled');
  });

  it('keeps the head and the tail of a large output and says it was cut', async () => {
    const outcome = await runProcess(
      process.execPath,
      ['-e', "process.stderr.write('A'.repeat(5000) + 'B'.repeat(5000) + 'END')"],
      limits,
    );
    expect(outcome.truncated).toBe(true);
    expect(outcome.stderr.length).toBeLessThanOrEqual(201);
    expect(outcome.stderr.startsWith('A')).toBe(true);
    expect(outcome.stderr.endsWith('END')).toBe(true);
  });
});

describe('runMediaQc without ffmpeg', () => {
  it('stops before running anything when the job is already cancelled', async () => {
    await expect(
      runMediaQc({
        jobId: 'job-1',
        assetId: 'asset-1',
        sourcePath: 'unused.mp4',
        cancelled: () => true,
        progress: async () => undefined,
        ffprobePath: 'joy-media-no-such-program',
      }),
    ).rejects.toThrow('canceled');
  });

  it('fails with a plain message when FFprobe cannot run, and never names the file', async () => {
    const run = runMediaQc({
      jobId: 'job-1',
      assetId: 'asset-1',
      sourcePath: 'C:\\private\\clip.mp4',
      cancelled: () => false,
      progress: async () => undefined,
      ffprobePath: 'joy-media-no-such-program',
    });
    await expect(run).rejects.toThrow('FFprobe failed');
    await run.catch((error: unknown) => {
      expect(String(error)).not.toContain('private');
    });
  });

  it('refuses a bad payload before it runs anything', async () => {
    await expect(
      runMediaQc({
        jobId: 'job-1',
        assetId: 'asset-1',
        sourcePath: 'unused.mp4',
        payload: { checks: ['nonsense'] },
        cancelled: () => false,
        progress: async () => undefined,
      }),
    ).rejects.toThrow('unknown check');
  });
});

function canRun(tool: string): boolean {
  return spawnSync(tool, ['-version'], { shell: false, stdio: 'ignore' }).status === 0;
}

describe.skipIf(!canRun('ffmpeg') || !canRun('ffprobe'))('media.qc on a generated clip', () => {
  // 0-2 s moving picture, 2-3 s black, 3-5 s moving, 5-7 s frozen colour, 7-8 s moving; a 440 Hz tone throughout.
  const BLACK_START_US = 2 * SECOND;
  const BLACK_END_US = 3 * SECOND;
  const FREEZE_START_US = 5 * SECOND;
  const FREEZE_END_US = 7 * SECOND;
  const TOLERANCE_US = 100_000;

  function generateClip(directory: string): string {
    const output = join(directory, 'qc-fixture.mkv');
    const size = 'size=320x240:rate=25';
    const segment = (index: number): string => `[${index}:v]format=yuv420p,setsar=1[v${index}]`;
    const result = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=${size}:duration=2`,
        '-f',
        'lavfi',
        '-i',
        `color=c=black:${size}:duration=1`,
        '-f',
        'lavfi',
        '-i',
        `testsrc2=${size}:duration=2`,
        '-f',
        'lavfi',
        '-i',
        `color=c=0x4080c0:${size}:duration=2`,
        '-f',
        'lavfi',
        '-i',
        `testsrc2=${size}:duration=1`,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=8',
        '-filter_complex',
        `${[0, 1, 2, 3, 4].map(segment).join(';')};[v0][v1][v2][v3][v4]concat=n=5:v=1:a=0[v]`,
        '-map',
        '[v]',
        '-map',
        '5:a',
        '-c:v',
        'ffv1',
        '-c:a',
        'pcm_s16le',
        output,
      ],
      { shell: false, encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error(`could not generate the fixture: ${result.stderr}`);
    return output;
  }

  it('finds the planted black part and the planted freeze within 100 ms', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-qc-test-'));
    try {
      const progress: number[] = [];
      const receipt = await runMediaQc({
        jobId: 'job-int',
        assetId: 'asset-int',
        sourcePath: generateClip(directory),
        cancelled: () => false,
        progress: async (value) => {
          progress.push(value);
        },
      });
      const { report } = receipt;
      expect(receipt.kind).toBe('media.qc');
      expect(progress.at(-1)).toBe(100);
      expect(report.technical?.durationUs).toBeGreaterThan(7_900_000);
      expect(report.technical?.durationUs).toBeLessThan(8_100_000);
      expect(report.technical?.truncated).toEqual([]);

      const black = report.findings.find((finding) => finding.type === 'black');
      expect(black).toBeDefined();
      expect(Math.abs((black?.startUs ?? 0) - BLACK_START_US)).toBeLessThanOrEqual(TOLERANCE_US);
      expect(Math.abs((black?.endUs ?? 0) - BLACK_END_US)).toBeLessThanOrEqual(TOLERANCE_US);

      // The black part is also a still picture, so more than one frozen run may be listed: one must be the colour block.
      const frozen = report.findings.filter((finding) => finding.type === 'frozen');
      const colourBlock = frozen.find(
        (finding) => Math.abs(finding.startUs - FREEZE_START_US) <= TOLERANCE_US,
      );
      expect(colourBlock).toBeDefined();
      expect(Math.abs((colourBlock?.endUs ?? 0) - FREEZE_END_US)).toBeLessThanOrEqual(TOLERANCE_US);

      // The hard cuts at the joins are reported too.
      const cuts = report.findings.filter((finding) => finding.type === 'scene-cut');
      expect(cuts.some((cut) => Math.abs(cut.startUs - BLACK_START_US) <= TOLERANCE_US)).toBe(true);
      expect(JSON.stringify(report)).not.toContain(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it('reads the loudness, the audio peak and the picture numbers from real ffmpeg output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-qc-test-'));
    try {
      const { report } = await runMediaQc({
        jobId: 'job-int-2',
        assetId: 'asset-int',
        sourcePath: generateClip(directory),
        cancelled: () => false,
        progress: async () => undefined,
      });
      const loudness = report.technical?.loudness;
      expect(loudness?.integratedLufs).toBeGreaterThan(-30);
      expect(loudness?.integratedLufs).toBeLessThan(-10);
      expect(report.technical?.audioPeakDb).toBeGreaterThan(-30);
      expect(report.technical?.audioPeakDb).toBeLessThan(0);
      expect(report.technical?.exposure?.sampledFrames).toBeGreaterThan(0);
      // A steady tone at a normal level is neither silent nor clipped.
      expect(report.findings.some((finding) => finding.type === 'silence')).toBe(false);
      expect(report.findings.some((finding) => finding.type === 'clipping')).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it('can be cancelled while it runs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-qc-test-'));
    try {
      const source = generateClip(directory);
      let cancel = false;
      await expect(
        runMediaQc({
          jobId: 'job-int-3',
          assetId: 'asset-int',
          sourcePath: source,
          cancelled: () => cancel,
          progress: async () => {
            cancel = true;
          },
        }),
      ).rejects.toThrow('canceled');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it('runs only the checks it was asked for', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-qc-test-'));
    try {
      const { report } = await runMediaQc({
        jobId: 'job-int-4',
        assetId: 'asset-int',
        sourcePath: generateClip(directory),
        payload: { checks: ['black'] },
        cancelled: () => false,
        progress: async () => undefined,
      });
      expect(report.technical?.checksRun).toEqual(['black']);
      expect(report.findings.every((finding) => finding.type === 'black')).toBe(true);
      expect(report.findings.length).toBeGreaterThan(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
