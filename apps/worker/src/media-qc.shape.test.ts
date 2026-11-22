import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QC_THRESHOLDS,
  parseCropdetect,
  parseMediaQcPayload,
  parseProbe,
  qcFindings,
  runMediaQc,
  type QcMeasurements,
} from './media-qc.js';

const SECOND = 1_000_000;

function measured(overrides: Partial<QcMeasurements>): QcMeasurements {
  return {
    durationUs: 10 * SECOND,
    hasVideo: true,
    hasAudio: false,
    checksRun: ['low-resolution', 'aspect-mismatch'],
    incomplete: false,
    truncated: [],
    elapsedMs: 5,
    ...overrides,
  };
}

const cropLine = (w: number, h: number, x: number, y: number): string =>
  `[Parsed_cropdetect_1 @ 000001] x1:${x} x2:${x + w - 1} y1:${y} y2:${y + h - 1} w:${w} h:${h} x:${x} y:${y} pts:0 t:0.000000 limit:0.094118 crop=${w}:${h}:${x}:${y}`;

describe('probe size', () => {
  it('reads the width and height of the first real video stream', () => {
    const probe = parseProbe(
      JSON.stringify({
        streams: [
          { codec_type: 'video', disposition: { attached_pic: 1 }, width: 500, height: 500 },
          { codec_type: 'video', disposition: { attached_pic: 0 }, width: 320, height: 180 },
        ],
        format: { duration: '2' },
      }),
    );
    expect(probe.videoWidth).toBe(320);
    expect(probe.videoHeight).toBe(180);
  });

  it('leaves the size out when the probe does not state it', () => {
    const probe = parseProbe(
      JSON.stringify({ streams: [{ codec_type: 'video' }], format: { duration: '1' } }),
    );
    expect(probe.videoWidth).toBeUndefined();
    expect(probe.videoHeight).toBeUndefined();
  });
});

describe('parseCropdetect', () => {
  it('takes the last box, which is the union of every sampled frame', () => {
    const text = [cropLine(1200, 600, 40, 180), cropLine(1280, 720, 0, 120)].join('\n');
    expect(parseCropdetect(text)).toEqual({ cropWidth: 1280, cropHeight: 720, sampledFrames: 2 });
  });
  it('returns nothing when there is no usable crop line', () => {
    expect(parseCropdetect('frame=1 fps=0')).toBeUndefined();
    expect(parseCropdetect(cropLine(0, 0, 0, 0))).toBeUndefined();
  });
});

describe('low resolution finding', () => {
  const size = (width: number, height: number) => ({ videoSize: { width, height } });
  const types = (m: QcMeasurements) => qcFindings(m, DEFAULT_QC_THRESHOLDS);

  it('flags a 320x180 picture as major and says what it measured', () => {
    const [finding] = types(measured(size(320, 180)));
    expect(finding?.type).toBe('low-resolution');
    expect(finding?.severity).toBe('major');
    expect(finding?.state).toBe('measured');
    expect(finding?.fixable).toBe(false);
    expect(finding?.measured).toEqual({ width: 320, height: 180, shortSidePx: 180 });
    expect(finding?.label).toContain('320x180');
  });
  it('flags a picture between 240 and 359 pixels as minor', () => {
    expect(types(measured(size(480, 270)))[0]?.severity).toBe('minor');
  });
  it('is quiet at 640x360 and for a tall picture of the same short side', () => {
    expect(types(measured(size(640, 360)))).toEqual([]);
    expect(types(measured(size(360, 640)))).toEqual([]);
  });
  it('does not report when the check did not run', () => {
    expect(types(measured({ ...size(320, 180), checksRun: [] }))).toEqual([]);
  });
});

describe('aspect and bar finding', () => {
  const frame = { videoSize: { width: 1280, height: 960 } };
  const findings = (m: QcMeasurements) => qcFindings(m, DEFAULT_QC_THRESHOLDS);

  it('flags 16:9 content padded into a 4:3 frame as a letterbox of 25%', () => {
    const [finding] = findings(
      measured({ ...frame, crop: { cropWidth: 1280, cropHeight: 720, sampledFrames: 20 } }),
    );
    expect(finding?.type).toBe('aspect-mismatch');
    expect(finding?.severity).toBe('major');
    expect(finding?.measured).toMatchObject({ bars: 'letterbox', barFraction: 0.25 });
    expect(finding?.label).toContain('above and below');
  });
  it('flags a pillarbox', () => {
    const [finding] = findings(
      measured({
        videoSize: { width: 1920, height: 1080 },
        crop: { cropWidth: 1440, cropHeight: 1080, sampledFrames: 20 },
      }),
    );
    expect(finding?.measured).toMatchObject({ bars: 'pillarbox', barFraction: 0.25 });
  });
  it('flags bars on all four sides', () => {
    const [finding] = findings(
      measured({
        videoSize: { width: 1000, height: 1000 },
        crop: { cropWidth: 800, cropHeight: 800, sampledFrames: 20 },
      }),
    );
    expect(finding?.measured).toMatchObject({ bars: 'both' });
  });
  it('ignores a rounding-size border and a full frame', () => {
    expect(
      findings(
        measured({ ...frame, crop: { cropWidth: 1276, cropHeight: 956, sampledFrames: 9 } }),
      ),
    ).toEqual([]);
    expect(
      findings(
        measured({ ...frame, crop: { cropWidth: 1280, cropHeight: 960, sampledFrames: 9 } }),
      ),
    ).toEqual([]);
  });
  it('does not call a nearly black picture a letterbox', () => {
    expect(
      findings(measured({ ...frame, crop: { cropWidth: 100, cropHeight: 60, sampledFrames: 9 } })),
    ).toEqual([]);
  });
  it('uses the bar threshold setting', () => {
    const m = measured({ ...frame, crop: { cropWidth: 1280, cropHeight: 900, sampledFrames: 9 } });
    expect(findings(m)).toEqual([]);
    expect(
      qcFindings(m, { ...DEFAULT_QC_THRESHOLDS, letterboxBarMinFraction: 0.05 })[0]?.severity,
    ).toBe('minor');
  });
});

describe('payload for the new checks', () => {
  it('runs them by default, accepts them by name and range-checks their settings', () => {
    expect(parseMediaQcPayload(undefined).checks.has('low-resolution')).toBe(true);
    expect(parseMediaQcPayload({ checks: ['aspect-mismatch'] }).checks.size).toBe(1);
    expect(
      parseMediaQcPayload({ thresholds: { lowResolutionMinShortSidePx: 480 } }).thresholds
        .lowResolutionMinShortSidePx,
    ).toBe(480);
    expect(() => parseMediaQcPayload({ thresholds: { letterboxBarMinFraction: 0.9 } })).toThrow(
      'letterboxBarMinFraction',
    );
  });
});

function canRun(tool: string): boolean {
  return spawnSync(tool, ['-version'], { shell: false, stdio: 'ignore' }).status === 0;
}

describe.skipIf(!canRun('ffmpeg') || !canRun('ffprobe'))(
  'media.qc picture shape on real clips',
  () => {
    // The base picture is `testsrc2`, which moves every frame: it is never a still, so `frozen` stays strict (Decision 177).
    function generate(directory: string, name: string, graph: string): string {
      const output = join(directory, name);
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
          'testsrc2=size=640x360:rate=25:duration=2',
          '-vf',
          graph,
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          output,
        ],
        { shell: false, encoding: 'utf8' },
      );
      if (result.status !== 0) throw new Error(`could not generate ${name}: ${result.stderr}`);
      return output;
    }
    const check = async (source: string) =>
      (
        await runMediaQc({
          jobId: 'job-shape',
          assetId: 'asset-shape',
          sourcePath: source,
          payload: { checks: ['low-resolution', 'aspect-mismatch', 'frozen'] },
          cancelled: () => false,
          progress: async () => undefined,
        })
      ).report;

    it('finds a 320x180 clip, a 4:3 letterbox and a pillarbox, and leaves a moving 16:9 clip clean', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'joy-media-qc-shape-'));
      try {
        const clean = await check(generate(directory, 'clean.mp4', 'null'));
        expect(clean.findings).toEqual([]);
        expect(clean.technical?.checksRun).toEqual(['frozen', 'low-resolution', 'aspect-mismatch']);

        const small = await check(generate(directory, 'small.mp4', 'scale=320:180'));
        expect(small.findings.map((finding) => finding.type)).toEqual(['low-resolution']);

        const letterbox = await check(
          generate(directory, 'letterbox.mp4', 'pad=640:480:0:60:black'),
        );
        const bars = letterbox.findings.find((finding) => finding.type === 'aspect-mismatch');
        expect(bars?.measured).toMatchObject({ bars: 'letterbox', width: 640, height: 480 });
        expect(Number(bars?.measured['barFraction'])).toBeGreaterThan(0.2);
        expect(letterbox.findings.some((finding) => finding.type === 'frozen')).toBe(false);

        const pillarbox = await check(
          generate(directory, 'pillarbox.mp4', 'pad=960:360:160:0:black'),
        );
        expect(
          pillarbox.findings.find((finding) => finding.type === 'aspect-mismatch')?.measured,
        ).toMatchObject({ bars: 'pillarbox' });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
