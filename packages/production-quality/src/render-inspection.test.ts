import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertApiSafeRenderReport,
  deliveryPromiseFromManifest,
  inspectRenderedDelivery,
  reportSummary,
  type DeliveryPromiseV1,
} from './index.js';
import { captionAssDocument } from '@joy-media/captions-core';

describe('bounded render inspection', () => {
  it('passes a moving H.264/AAC render that satisfies the delivery promise', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-quality-good-'));
    const output = join(directory, 'moving.mp4');
    ffmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=64x36:rate=30:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=48000:duration=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-shortest',
      output,
    ]);

    const report = inspectRenderedDelivery(output, promise(), {
      mode: 'sampled',
      outputRef: 'render-good-aaaaaaaaaaaaaaaa',
    });

    expect(reportSummary(report).fail).toBe(0);
    expect(report.facts.video?.frames).toBeGreaterThanOrEqual(29);
    expect(report.facts.audio?.rms).toBeGreaterThan(0.001);
    expect(report.artifact?.sha256).toBe(fileHash(output));
    expect(() => assertApiSafeRenderReport(report)).not.toThrow();
    expect(JSON.stringify(report)).not.toContain(output);
  });

  it('fails wrong duration, frame count, fps, dimensions, missing sidecar captions, and missing audio', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-quality-no-audio-'));
    const output = join(directory, 'video-only.mp4');
    ffmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=32x18:rate=15:duration=0.5',
      '-an',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      output,
    ]);

    const report = inspectRenderedDelivery(
      output,
      {
        ...promise(),
        captions: { mode: 'sidecar', required: true },
      },
      { mode: 'sampled', outputRef: 'render-bad-bbbbbbbbbbbbbbbb' },
    );

    expect(failCodes(report)).toEqual(
      expect.arrayContaining([
        'duration',
        'frame-count',
        'frame-rate',
        'dimensions',
        'audio-presence',
        'caption-sidecar',
      ]),
    );
  });

  it('fails silence, sample-rate and channel mismatches', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-quality-silence-'));
    const output = join(directory, 'silence-mono.mp4');
    ffmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=64x36:rate=30:duration=1',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=44100:cl=mono:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      output,
    ]);

    const report = inspectRenderedDelivery(output, promise(), {
      mode: 'sampled',
      outputRef: 'render-silence-cccccccccccccccc',
    });

    expect(failCodes(report)).toEqual(
      expect.arrayContaining(['audio-sample-rate', 'audio-channels', 'audio-silence']),
    );
  });

  it('fails clipped audio samples', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-quality-clipped-'));
    const output = join(directory, 'clipped.wav');
    ffmpeg(['-y', '-f', 'lavfi', '-i', 'aevalsrc=1:d=0.2:s=48000', '-c:a', 'pcm_s16le', output]);

    const report = inspectRenderedDelivery(
      output,
      {
        ...promise(),
        container: 'wav',
        video: { ...promise().video, required: false },
        audio: { ...promise().audio, codec: 'pcm_s16le', channels: 1, maxClippedSamples: 0 },
      },
      { mode: 'sampled', outputRef: 'render-clip-dddddddddddddddd' },
    );

    expect(failCodes(report)).toContain('audio-clipping');
  });

  it('fails black blank and duplicate frame spans without reading the whole render', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-quality-black-'));
    const output = join(directory, 'black.mp4');
    ffmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=64x36:r=30:d=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      output,
    ]);

    const basePromise = promise();
    const report = inspectRenderedDelivery(
      output,
      { ...basePromise, video: { ...basePromise.video, maxDuplicateFrames: 4 } },
      {
        mode: 'sampled',
        outputRef: 'render-black-eeeeeeeeeeeeeeee',
      },
    );

    expect(failCodes(report)).toEqual(
      expect.arrayContaining(['black-frames', 'blank-frames', 'duplicate-frames']),
    );
  });

  it('reports sampled caption-pixel evidence only when a burn-in promise carries cue evidence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-quality-caption-'));
    const output = join(directory, 'caption-missing.mp4');
    ffmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x404040:s=64x36:r=30:d=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-shortest',
      output,
    ]);
    const base = promise();
    const report = inspectRenderedDelivery(
      output,
      {
        ...base,
        captions: {
          mode: 'burned-in',
          required: true,
          burnIn: {
            styleRef: 'joy-clean',
            segments: [{ startUs: 0, endUs: 1_000_000, text: 'JOY', direction: 'ltr' }],
          },
        },
      },
      { mode: 'sampled', outputRef: 'render-caption-missing-ffffffff' },
    );
    expect(failCodes(report)).toContain('caption-pixels');
    const generic = inspectRenderedDelivery(
      output,
      {
        ...base,
        captions: { mode: 'burned-in', required: true },
      },
      { mode: 'sampled', outputRef: 'render-caption-generic-gggggggg' },
    );
    expect(
      generic.findings.find((finding) => finding.code === 'caption-pixels-unproven')?.status,
    ).toBe('warn');

    const assPath = join(directory, 'caption-fixture.ass');
    writeFileSync(assPath, captionAssFixture());
    const retained = join(directory, 'caption-retained.mp4');
    ffmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x404040:s=64x36:r=30:d=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-vf',
      `subtitles=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(fontsDirectory())}`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-shortest',
      retained,
    ]);
    const positive = inspectRenderedDelivery(
      retained,
      {
        ...base,
        captions: {
          mode: 'burned-in',
          required: true,
          burnIn: {
            styleRef: 'joy-clean',
            segments: [{ startUs: 0, endUs: 1_000_000, text: 'JOY', direction: 'ltr' }],
          },
        },
      },
      { mode: 'sampled', outputRef: 'render-caption-retained-hhhhhhhh' },
    );
    expect(failCodes(positive)).not.toContain('caption-pixels');

    const unrelated = join(directory, 'caption-drawbox.mp4');
    ffmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x404040:s=64x36:r=30:d=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-vf',
      'drawbox=x=18:y=26:w=28:h=8:color=white:t=fill',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-shortest',
      unrelated,
    ]);
    const falsePositive = inspectRenderedDelivery(
      unrelated,
      {
        ...base,
        captions: {
          mode: 'burned-in',
          required: true,
          burnIn: {
            styleRef: 'joy-clean',
            segments: [{ startUs: 0, endUs: 1_000_000, text: 'JOY', direction: 'ltr' }],
          },
        },
      },
      { mode: 'sampled', outputRef: 'render-caption-drawbox-iiiiiiii' },
    );
    expect(failCodes(falsePositive)).toContain('caption-pixels');
  });
});

function promise(): DeliveryPromiseV1 {
  return {
    ...deliveryPromiseFromManifest({
      projectId: 'visual',
      revision: 1,
      width: 64,
      height: 36,
      frameRate: 30,
      durationUs: 1_000_000,
      preset: 'social-h264-aac',
    }),
    video: {
      ...deliveryPromiseFromManifest({
        projectId: 'visual',
        revision: 1,
        width: 64,
        height: 36,
        frameRate: 30,
        durationUs: 1_000_000,
        preset: 'social-h264-aac',
      }).video,
      maxBlackFrames: 2,
      maxBlankFrames: 2,
      maxDuplicateFrames: 20,
    },
    audio: {
      required: true,
      codec: 'aac',
      sampleRate: 48000,
      channels: 2,
      minRms: 0.001,
      maxPeak: 1,
      maxClippedSamples: 0,
    },
  };
}

function failCodes(report: ReturnType<typeof inspectRenderedDelivery>): readonly string[] {
  return report.findings
    .filter((finding) => finding.status === 'fail')
    .map((finding) => finding.code);
}

function ffmpeg(args: readonly string[]): void {
  const result = spawnSync('ffmpeg', args, { shell: false, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr}`);
}

function fileHash(path: string): string {
  expect(existsSync(path)).toBe(true);
  const probe = spawnSync('ffprobe', ['-v', 'error', path], { shell: false });
  expect(probe.status).toBe(0);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fontsDirectory(): string {
  return join(process.cwd(), 'apps', 'editor-web', 'public', 'assets', 'fonts', 'falsafeh');
}

function escapeFilterPath(path: string): string {
  return `'${path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}'`;
}

function captionAssFixture(): string {
  return captionAssDocument(
    { styleRef: 'joy-clean', segments: [{ startUs: 0, endUs: 1_000_000, text: 'JOY' }] },
    { width: 64, height: 36 },
  );
}
