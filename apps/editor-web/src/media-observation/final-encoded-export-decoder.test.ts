import { describe, expect, it } from 'vitest';
import {
  BrowserFinalEncodedExportDecoder,
  FINAL_ENCODED_EXPORT_BROWSER_DECODER_VERSION,
  createBrowserFinalEncodedExportDecoder,
} from './final-encoded-export-decoder.js';
import type {
  FinalEncodedExportDecodeLimits,
  FinalEncodedExportDecodeRequest,
} from './render-verification.js';

const LIMITS: FinalEncodedExportDecodeLimits = {
  maxArtifactBytes: 1_000,
  maxPresentationPts: 10,
  maxDecodedFrames: 2,
  maxFramePixels: 16,
  maxDecodedPixelBytes: 64,
  maxAudioSampleValues: 100,
};

function request(
  overrides: Partial<FinalEncodedExportDecodeRequest> = {},
): FinalEncodedExportDecodeRequest {
  return {
    artifact: {
      artifactId: 'final-export-fixture-1',
      encoded: new Blob(['not a valid video'], { type: 'video/mp4' }),
    },
    requestedPixelPtsUs: [],
    requestedAudioWindows: [],
    limits: LIMITS,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('browser final encoded export decoder', () => {
  it('advertises the explicit actual-final-export marker and no source/canvas input seam', () => {
    const decoder = createBrowserFinalEncodedExportDecoder();

    expect(decoder).toMatchObject({
      kind: 'actual-encoded-export-decoder',
      version: FINAL_ENCODED_EXPORT_BROWSER_DECODER_VERSION,
    });
    expect(Object.keys(decoder)).not.toContain('source');
    expect(Object.keys(decoder)).not.toContain('canvas');
  });

  it('refuses an empty Blob before opening any browser decoder input', async () => {
    const result = await new BrowserFinalEncodedExportDecoder().decode(
      request({
        artifact: {
          artifactId: 'final-export-fixture-1',
          encoded: new Blob([], { type: 'video/mp4' }),
        },
      }),
    );

    expect(result).toEqual({ status: 'blocked', code: 'artifact-not-readable' });
  });

  it('enforces the caller artifact limit before an encoded Blob is inspected', async () => {
    const result = await new BrowserFinalEncodedExportDecoder().decode(
      request({
        artifact: {
          artifactId: 'final-export-fixture-1',
          encoded: new Blob(['two bytes'], { type: 'video/mp4' }),
        },
        limits: { ...LIMITS, maxArtifactBytes: 1 },
      }),
    );

    expect(result).toEqual({ status: 'blocked', code: 'decoder-policy' });
  });

  it('rejects malformed or unbounded requested media ranges before opening artifact bytes', async () => {
    const result = await new BrowserFinalEncodedExportDecoder().decode(
      request({
        requestedPixelPtsUs: [0, 0],
        requestedAudioWindows: [{ startUs: 9, endUs: 9 }],
      }),
    );

    expect(result).toEqual({ status: 'blocked', code: 'artifact-not-readable' });
  });

  it('enforces a hard cap on sparse audio windows before opening artifact bytes', async () => {
    const result = await new BrowserFinalEncodedExportDecoder().decode(
      request({
        requestedAudioWindows: Array.from({ length: 65 }, (_, index) => ({
          startUs: index * 2,
          endUs: index * 2 + 1,
        })),
      }),
    );

    expect(result).toEqual({ status: 'blocked', code: 'decoder-policy' });
  });

  it('propagates caller cancellation rather than reporting a finished export inspection', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      new BrowserFinalEncodedExportDecoder().decode(request({ signal: controller.signal })),
    ).rejects.toThrow('cancelled');
  });

  it('fails closed for corrupted final bytes even when a verifier requires real video and audio samples', async () => {
    const result = await new BrowserFinalEncodedExportDecoder().decode(
      request({
        requestedPixelPtsUs: [0],
        requestedAudioWindows: [{ startUs: 0, endUs: 1 }],
      }),
    );

    expect(result.status).not.toBe('decoded');
    expect(JSON.stringify(result)).not.toContain('final-export-fixture-1');
    expect(JSON.stringify(result)).not.toContain('not a valid video');
  });

  it('rejects a source-cache budget above the independently bounded decoder cache', () => {
    expect(() =>
      createBrowserFinalEncodedExportDecoder({
        maxSourceCacheBytes: 64 * 1024 * 1024 + 1,
      }),
    ).toThrow('maxSourceCacheBytes');
  });
});
