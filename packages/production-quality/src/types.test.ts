import { describe, expect, it } from 'vitest';
import {
  assertApiSafeRenderReport,
  deliveryPromiseFromManifest,
  reportSummary,
  type DeliveryPromiseV1,
  type RenderReportV1,
} from './index.js';

describe('delivery promise and render report contracts', () => {
  it('creates a frozen default promise from a render manifest', () => {
    const promise = deliveryPromiseFromManifest({
      projectId: 'project-1',
      revision: 7,
      width: 1920,
      height: 1080,
      frameRate: 30,
      durationUs: 2_000_000,
      preset: 'youtube-1080',
    });

    expect(promise).toMatchObject({
      version: 1,
      container: 'mp4',
      video: {
        codec: 'h264',
        width: 1920,
        height: 1080,
        frameRate: 30,
        durationUs: 2_000_000,
        expectedFrames: 60,
      },
      audio: { required: true, codec: 'aac', sampleRate: 48000, channels: 2 },
      captions: { mode: 'none' },
      deterministic: { requireDeterministicEffects: true },
    });
    expect(Object.isFrozen(promise)).toBe(true);
  });

  it('summarizes evidence findings and rejects path-bearing reports', () => {
    const report: RenderReportV1 = {
      version: 1,
      promiseId: 'promise-project-1-7-youtube-1080',
      checkedAt: '1970-01-01T00:00:00.000Z',
      artifact: {
        outputRef: 'render-job-1-aaaaaaaaaaaaaaaa',
        sha256: 'a'.repeat(64),
        bytes: 2048,
      },
      facts: {
        container: 'mp4',
        video: {
          codec: 'h264',
          width: 1920,
          height: 1080,
          frameRate: 30,
          durationUs: 2_000_000,
          frames: 60,
          sampledFrames: 6,
          blackFrames: 0,
          duplicateFrames: 0,
        },
        audio: {
          codec: 'aac',
          sampleRate: 48000,
          channels: 2,
          durationUs: 2_000_000,
          rms: 0.125,
          peak: 0.6,
          clippedSamples: 0,
        },
        subtitles: { streams: 0 },
      },
      findings: [
        { code: 'video-codec', status: 'pass', message: 'video codec matches promise' },
        { code: 'duration', status: 'fail', message: 'duration is outside tolerance' },
      ],
    };

    expect(reportSummary(report)).toEqual({ pass: 1, warn: 0, fail: 1 });
    expect(() => assertApiSafeRenderReport(report)).not.toThrow();
    expect(() =>
      assertApiSafeRenderReport({
        ...report,
        artifact: { ...report.artifact!, outputRef: 'C:\\Users\\Owner\\render.mp4' },
      }),
    ).toThrow(/paths or urls/i);
  });

  it('keeps the public promise shape JSON-safe and bounded', () => {
    const promise: DeliveryPromiseV1 = deliveryPromiseFromManifest({
      projectId: 'project-1',
      revision: 1,
      width: 1080,
      height: 1920,
      frameRate: 60,
      durationUs: 1_000_000,
      preset: 'reels-1080',
    });

    expect(JSON.stringify(promise)).not.toMatch(/[A-Za-z]:[\\/]|file:|https?:\/\//);
    expect(JSON.stringify(promise).length).toBeLessThan(4096);
  });
});
