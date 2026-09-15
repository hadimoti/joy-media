import { describe, expect, it, vi } from 'vitest';
import {
  createFinalEncodedExportVerifier,
  type DecodedFinalEncodedExport,
  type FinalEncodedExportDecoder,
  type FinalEncodedExportVerificationRequest,
} from './render-verification.js';

const TITLE_PIXEL: readonly [number, number, number, number] = [214, 164, 48, 255];
const EFFECT_PIXEL: readonly [number, number, number, number] = [36, 172, 239, 255];

function artifact(): FinalEncodedExportVerificationRequest['artifact'] {
  return {
    artifactId: 'encoded-export-fixture-1',
    encoded: new Blob(['not a source canvas'], { type: 'video/mp4' }),
  };
}

function request(
  overrides: Partial<FinalEncodedExportVerificationRequest> = {},
): FinalEncodedExportVerificationRequest {
  return {
    artifact: artifact(),
    expected: {
      container: 'mp4',
      width: 2,
      height: 2,
      durationUs: 1_100_000,
      expectedVideoPtsUs: [0, 1_000_000],
      videoCodec: 'h264',
      audioCodec: 'aac',
      visualPredicates: [
        {
          kind: 'black-frame',
          id: 'opening-black',
          ptsUs: 0,
          expected: 'black',
          blackThreshold: 8,
          minimumFraction: 1,
        },
        {
          kind: 'pixel',
          id: 'title-visible',
          target: 'title',
          ptsUs: 1_000_000,
          x: 0,
          y: 0,
          expectedRgba: TITLE_PIXEL,
          tolerance: 0,
        },
        {
          kind: 'pixel',
          id: 'effect-visible',
          target: 'effect',
          ptsUs: 1_000_000,
          x: 1,
          y: 0,
          expectedRgba: EFFECT_PIXEL,
          tolerance: 0,
        },
      ],
      audioSyncPredicates: [
        {
          kind: 'audio-peak-sync',
          id: 'flash-impulse-sync',
          videoPtsUs: 1_000_000,
          expectedAudioPeakUs: 1_000_000,
          maxDriftUs: 2_000,
          minimumPeakAmplitude: 0.8,
        },
      ],
    },
    ...overrides,
  };
}

function decoded(overrides: Partial<DecodedFinalEncodedExport> = {}): DecodedFinalEncodedExport {
  const impulse = new Float32Array(1_100);
  impulse[1_000] = 1;
  return {
    container: 'mp4',
    durationUs: 1_100_000,
    videoStreams: [
      {
        streamId: 'video-0',
        codec: 'h264',
        width: 2,
        height: 2,
        durationUs: 1_100_000,
        presentationPtsUs: [0, 1_000_000],
        presentationPtsComplete: true,
        frames: [
          {
            ptsUs: 0,
            width: 2,
            height: 2,
            rgba: new Uint8Array(16),
          },
          {
            ptsUs: 1_000_000,
            width: 2,
            height: 2,
            rgba: Uint8Array.from([
              ...TITLE_PIXEL,
              ...EFFECT_PIXEL,
              12,
              12,
              12,
              255,
              12,
              12,
              12,
              255,
            ]),
          },
        ],
      },
    ],
    audioStreams: [
      {
        streamId: 'audio-0',
        codec: 'aac',
        durationUs: 1_100_000,
        sampleRate: 1_000,
        channelCount: 1,
        windows: [{ startUs: 0, sampleRate: 1_000, channels: [impulse] }],
      },
    ],
    ...overrides,
  };
}

function actualDecoder(
  result: DecodedFinalEncodedExport,
): FinalEncodedExportDecoder & { readonly decode: ReturnType<typeof vi.fn> } {
  return {
    kind: 'actual-encoded-export-decoder',
    version: 'fixture-decoder-v1',
    decode: vi.fn(async () => ({ status: 'decoded' as const, decoded: result })),
  };
}

describe('final encoded export verification', () => {
  it('proves the final decoded container, streams, PTS, pixels, title/effect and audio impulse together', async () => {
    const decoder = actualDecoder(decoded());
    const verifier = createFinalEncodedExportVerifier({ decoder });

    const result = await verifier.verify(request());

    expect(result).toMatchObject({
      status: 'verified',
      scope: 'decoded-final-encoded-export',
      facts: {
        container: 'mp4',
        width: 2,
        height: 2,
        durationUs: 1_100_000,
        videoStreamCount: 1,
        audioStreamCount: 1,
        presentationFrameCount: 2,
      },
    });
    expect(decoder.decode).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedPixelPtsUs: [0, 1_000_000],
        requestedAudioWindows: [
          { startUs: 0, endUs: 100_000 },
          { startUs: 998_000, endUs: 1_002_001 },
        ],
        limits: expect.objectContaining({ maxDecodedFrames: expect.any(Number) }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain('encoded-export-fixture-1');
    expect(JSON.stringify(result)).not.toContain('214,164,48,255');
  });

  it('does not mistake a source-canvas or recorder completion for decoded export proof when no actual decoder exists', async () => {
    const result = await createFinalEncodedExportVerifier().verify(request());

    expect(result).toEqual({ status: 'unavailable', code: 'decoder-unavailable' });
  });

  it('does not turn an unavailable browser decode capability into a verified receipt', async () => {
    const unavailableDecoder: FinalEncodedExportDecoder = {
      kind: 'actual-encoded-export-decoder',
      version: 'webcodecs-unavailable-fixture-v1',
      decode: async () => ({ status: 'unavailable', code: 'decoder-unavailable' }),
    };

    const result = await createFinalEncodedExportVerifier({ decoder: unavailableDecoder }).verify(
      request({
        expected: {
          ...request().expected,
          visualPredicates: [],
          audioSyncPredicates: [],
        },
      }),
    );

    expect(result).toEqual({ status: 'unavailable', code: 'decoder-unavailable' });
  });

  const silentExpectation = (): FinalEncodedExportVerificationRequest['expected'] => {
    const { audioCodec: _audioCodec, ...rest } = request().expected;
    return { ...rest, audioStreamCount: 0, audioSyncPredicates: [] };
  };

  it('verifies a deliberately silent export against zero audio streams', async () => {
    const silentRequest = request({ expected: silentExpectation() });
    const decoder = actualDecoder(decoded({ audioStreams: [] }));

    const result = await createFinalEncodedExportVerifier({ decoder }).verify(silentRequest);

    expect(result).toMatchObject({
      status: 'verified',
      facts: { audioStreamCount: 0, videoStreamCount: 1 },
    });
    expect(decoder.decode).toHaveBeenCalledWith(
      expect.objectContaining({ requestedAudioWindows: [] }),
    );
    expect(
      (result as { checks: readonly { id: string }[] }).checks.map((entry) => entry.id),
    ).not.toContain('audio-decode');
  });

  it('fails closed for a silent-export expectation when the decoded artifact still carries audio', async () => {
    const silentRequest = request({ expected: silentExpectation() });
    const decoder = actualDecoder(decoded());

    const result = await createFinalEncodedExportVerifier({ decoder }).verify(silentRequest);

    expect(result.status).toBe('failed');
  });

  it('rejects a zero-audio expectation that still declares an audio codec', async () => {
    const contradictory = request({
      expected: { ...request().expected, audioStreamCount: 0, audioSyncPredicates: [] },
    });

    await expect(
      createFinalEncodedExportVerifier({
        decoder: actualDecoder(decoded({ audioStreams: [] })),
      }).verify(contradictory),
    ).rejects.toThrow(/invalid/i);
  });

  it('requires bounded RGBA and PCM evidence even when no subjective creative predicate exists', async () => {
    const withoutCreativePredicates = request({
      expected: {
        ...request().expected,
        visualPredicates: [],
        audioSyncPredicates: [],
      },
    });
    const decoder = actualDecoder(
      decoded({
        videoStreams: [{ ...decoded().videoStreams[0]!, frames: [] }],
        audioStreams: [{ ...decoded().audioStreams[0]!, windows: [] }],
      }),
    );

    const result = await createFinalEncodedExportVerifier({ decoder }).verify(
      withoutCreativePredicates,
    );

    expect(decoder.decode).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedPixelPtsUs: [0],
        requestedAudioWindows: [{ startUs: 0, endUs: 100_000 }],
      }),
    );
    expect(result).toEqual({
      status: 'failed',
      code: 'missing-decoded-frame',
      checkId: 'decoded-video-sample',
    });
  });

  it('cannot issue a verified receipt when final audio was not actually decoded', async () => {
    const decoder = actualDecoder(
      decoded({
        videoStreams: [
          {
            ...decoded().videoStreams[0]!,
            frames: [decoded().videoStreams[0]!.frames[0]!],
          },
        ],
        audioStreams: [{ ...decoded().audioStreams[0]!, windows: [] }],
      }),
    );
    const result = await createFinalEncodedExportVerifier({ decoder }).verify(
      request({
        expected: {
          ...request().expected,
          visualPredicates: [],
          audioSyncPredicates: [],
        },
      }),
    );

    expect(result).toEqual({
      status: 'failed',
      code: 'missing-decoded-audio',
      checkId: 'decoded-audio-sample',
    });
  });

  it('rejects an adapter that is not explicitly an actual encoded-export decoder', async () => {
    const unsafeDecoder = {
      kind: 'canvas-readback',
      version: 'pretend-v1',
      decode: vi.fn(),
    } as unknown as FinalEncodedExportDecoder;

    const result = await createFinalEncodedExportVerifier({ decoder: unsafeDecoder }).verify(
      request(),
    );

    expect(result).toEqual({ status: 'unavailable', code: 'decoder-not-actual' });
  });

  it('fails closed for dropped or shifted final PTS rather than accepting an encoded recorder event', async () => {
    const bad = decoded({
      videoStreams: [
        {
          ...decoded().videoStreams[0]!,
          presentationPtsUs: [0, 990_000],
        },
      ],
    });

    const result = await createFinalEncodedExportVerifier({ decoder: actualDecoder(bad) }).verify(
      request(),
    );

    expect(result).toEqual({ status: 'failed', code: 'video-pts-mismatch' });
  });

  it('fails a title/effect predicate when the decoded final pixels disagree', async () => {
    const bad = decoded();
    const frame = bad.videoStreams[0]!.frames[1]!;
    const altered = Uint8Array.from(frame.rgba);
    altered[0] = 0;
    const result = await createFinalEncodedExportVerifier({
      decoder: actualDecoder({
        ...bad,
        videoStreams: [
          {
            ...bad.videoStreams[0]!,
            frames: [bad.videoStreams[0]!.frames[0]!, { ...frame, rgba: altered }],
          },
        ],
      }),
    }).verify(request());

    expect(result).toEqual({
      status: 'failed',
      code: 'pixel-predicate-failed',
      checkId: 'title-visible',
    });
  });

  it('blocks success when actual decoded audio lacks the synchronized impulse', async () => {
    const bad = decoded({
      audioStreams: [
        {
          ...decoded().audioStreams[0]!,
          windows: [{ startUs: 0, sampleRate: 1_000, channels: [new Float32Array(1_100)] }],
        },
      ],
    });

    const result = await createFinalEncodedExportVerifier({ decoder: actualDecoder(bad) }).verify(
      request(),
    );

    expect(result).toEqual({
      status: 'failed',
      code: 'audio-sync-predicate-failed',
      checkId: 'flash-impulse-sync',
    });
  });

  it('bounds decoded pixel data and sanitizes decoder failures instead of returning paths, URLs, keys, or raw bytes', async () => {
    const oversized = decoded({
      videoStreams: [
        {
          ...decoded().videoStreams[0]!,
          frames: [
            {
              ptsUs: 0,
              width: 2,
              height: 2,
              rgba: new Uint8Array(16),
            },
            {
              ptsUs: 1_000_000,
              width: 2,
              height: 2,
              rgba: new Uint8Array(16),
            },
          ],
        },
      ],
    });
    const bounded = await createFinalEncodedExportVerifier({
      decoder: actualDecoder(oversized),
      maxDecodedPixelBytes: 16,
    }).verify(request());
    expect(bounded).toEqual({ status: 'failed', code: 'decoded-pixel-budget-exceeded' });

    const decoder: FinalEncodedExportDecoder = {
      kind: 'actual-encoded-export-decoder',
      version: 'fixture-decoder-v1',
      decode: async () => {
        throw new Error(
          'C:\\private\\media.mp4 https://provider.example/?key=secret raw-frame-bytes',
        );
      },
    };
    const failed = await createFinalEncodedExportVerifier({ decoder }).verify(request());
    expect(failed).toEqual({ status: 'failed', code: 'decoder-failed' });
    expect(JSON.stringify(failed)).not.toMatch(/private|provider|secret|raw-frame/i);
  });

  it('reserves aggregate verifier-owned RGBA and PCM copies before later buffers allocate', async () => {
    const twoFrames = decoded({
      videoStreams: [
        {
          ...decoded().videoStreams[0]!,
          frames: [decoded().videoStreams[0]!.frames[0]!, decoded().videoStreams[0]!.frames[1]!],
        },
      ],
    });
    const pixelBounded = await createFinalEncodedExportVerifier({
      decoder: actualDecoder(twoFrames),
      maxDecodedPixelBytes: 16,
    }).verify(request());
    expect(pixelBounded).toEqual({ status: 'failed', code: 'decoded-pixel-budget-exceeded' });

    const audioBounded = await createFinalEncodedExportVerifier({
      decoder: actualDecoder(
        decoded({
          audioStreams: [
            {
              ...decoded().audioStreams[0]!,
              sampleRate: 10_000,
              windows: [
                {
                  startUs: 0,
                  sampleRate: 10_000,
                  channels: [new Float32Array(800)],
                },
                {
                  startUs: 998_000,
                  sampleRate: 10_000,
                  channels: [new Float32Array(800)],
                },
              ],
            },
          ],
        }),
      ),
      maxAudioSampleValues: 1_500,
    }).verify(request());
    expect(audioBounded).toEqual({ status: 'failed', code: 'decoded-audio-budget-exceeded' });
  });

  it('sanitizes malformed decoder replies instead of throwing their implementation detail through the host', async () => {
    const decoder: FinalEncodedExportDecoder = {
      kind: 'actual-encoded-export-decoder',
      version: 'fixture-decoder-v1',
      decode: async () =>
        ({
          status: 'decoded',
          decoded: 'file:///private/export.mp4?key=secret',
        }) as unknown as ReturnType<FinalEncodedExportDecoder['decode']>,
    };

    const result = await createFinalEncodedExportVerifier({ decoder }).verify(request());
    expect(result).toEqual({ status: 'failed', code: 'invalid-decoder-output' });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|file/i);
  });

  it('returns a cancellation result when the host revokes the verification run', async () => {
    const controller = new AbortController();
    const decoder: FinalEncodedExportDecoder = {
      kind: 'actual-encoded-export-decoder',
      version: 'fixture-decoder-v1',
      decode: async () => {
        controller.abort();
        return { status: 'decoded', decoded: decoded() };
      },
    };

    const result = await createFinalEncodedExportVerifier({ decoder }).verify(
      request({ signal: controller.signal }),
    );
    expect(result).toEqual({ status: 'cancelled' });
  });
});
