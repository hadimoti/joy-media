import { describe, expect, it } from 'vitest';
import {
  FinalExportVerificationGateError,
  createFinalEncodedExportExpectation,
  createFinalExportVerificationReceipt,
  finalExportVerificationMessage,
  isFinalExportVerificationReceipt,
} from './export-final-verification.js';
import { createFinalEncodedExportVerifier } from './media-observation/render-verification.js';

const checkedAt = '2026-09-06T01:02:03.000Z';
const decoderVersion = 'joy-browser-final-encoded-export-decoder-v1';

describe('final export verification integration helpers', () => {
  it('derives a bounded structural final-MP4 contract from the immutable export manifest', () => {
    const expected = createFinalEncodedExportExpectation({
      width: 1080,
      height: 1920,
      frameRate: 30,
      durationUs: 3_000_000,
      frameCount: 90,
    });

    expect(expected).toMatchObject({
      container: 'mp4',
      width: 1080,
      height: 1920,
      durationUs: 3_000_000,
      videoCodec: 'avc',
      audioCodec: 'aac',
      videoStreamCount: 1,
      audioStreamCount: 1,
    });
    expect(expected.expectedVideoPtsUs).toHaveLength(90);
    expect(expected.expectedVideoPtsUs.slice(0, 4)).toEqual([0, 33_333, 66_666, 100_000]);
    expect(expected.visualPredicates).toEqual([]);
    expect(expected.audioSyncPredicates).toEqual([]);
    expect(expected.videoPtsToleranceUs).toBe(0);
    expect(expected.durationToleranceUs).toBeGreaterThanOrEqual(33_333);
  });

  it('uses the browser decoder’s canonical avc token for the Worker’s H.264 MP4 stream', () => {
    const expected = createFinalEncodedExportExpectation({
      width: 1920,
      height: 1080,
      frameRate: 30,
      durationUs: 1_000_000,
      frameCount: 30,
    });

    // The actual browser-decoder fixture exposes FFmpeg H.264 as `avc`.
    // Keep the encoder label out of this comparison boundary.
    expect(expected.videoCodec).toBe('avc');
  });

  it('refuses a frame count that is not the immutable manifest cadence', () => {
    expect(() =>
      createFinalEncodedExportExpectation({
        width: 1080,
        height: 1920,
        frameRate: 30,
        durationUs: 3_000_000,
        frameCount: 89,
      }),
    ).toThrow('frame count differs');
  });

  it('keeps a one-frame duration allowance inside the verifier’s bounded request contract', () => {
    const expected = createFinalEncodedExportExpectation({
      width: 1080,
      height: 1920,
      frameRate: 30,
      durationUs: 20_000,
      frameCount: 1,
    });

    expect(expected.durationToleranceUs).toBe(20_000);
    expect(expected.videoPtsToleranceUs).toBe(0);
  });

  it('documents the sub-frame manifest shape the generic verifier currently rejects if given an uncapped frame allowance', async () => {
    const expected = createFinalEncodedExportExpectation({
      width: 1080,
      height: 1920,
      frameRate: 30,
      durationUs: 20_000,
      frameCount: 1,
    });
    const request = {
      artifact: {
        artifactId: 'final-export-sub-frame-contract',
        encoded: new Blob(['final mp4 bytes'], { type: 'video/mp4' }),
      },
      expected,
    };
    const verifier = createFinalEncodedExportVerifier();

    await expect(verifier.verify(request)).resolves.toMatchObject({ status: 'unavailable' });
    await expect(
      verifier.verify({
        ...request,
        expected: { ...expected, durationToleranceUs: Math.ceil(1_000_000 / 30) },
      }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('stores a verified receipt as facts and check kinds only', () => {
    const receipt = createFinalExportVerificationReceipt(
      {
        status: 'verified',
        scope: 'decoded-final-encoded-export',
        facts: {
          container: 'mp4',
          width: 1080,
          height: 1920,
          durationUs: 3_000_000,
          videoStreamCount: 1,
          audioStreamCount: 1,
          presentationFrameCount: 90,
        },
        checks: [
          { id: 'container', kind: 'container' },
          { id: 'video-pts', kind: 'video-pts' },
          { id: 'decoded-video-sample', kind: 'video-decode' },
          { id: 'decoded-audio-sample', kind: 'audio-decode' },
        ],
      },
      { decoderVersion, checkedAt },
    );

    expect(receipt).toEqual({
      verifierVersion: 'joy-final-encoded-export-verifier-v1',
      decoderVersion,
      checkedAt,
      status: 'verified',
      scope: 'decoded-final-encoded-export',
      facts: {
        container: 'mp4',
        width: 1080,
        height: 1920,
        durationUs: 3_000_000,
        videoStreamCount: 1,
        audioStreamCount: 1,
        presentationFrameCount: 90,
      },
      checkKinds: ['container', 'video-pts', 'video-decode', 'audio-decode'],
    });
    expect(JSON.stringify(receipt)).not.toMatch(/blob|asset|pixel|audio sample|url|path/i);
    expect(isFinalExportVerificationReceipt(receipt)).toBe(true);
  });

  it('keeps unavailable verification distinct and emits only sanitized retry guidance', () => {
    const receipt = createFinalExportVerificationReceipt(
      { status: 'unavailable', code: 'decoder-unavailable' },
      { decoderVersion, checkedAt },
    );
    const error = new FinalExportVerificationGateError(receipt);

    expect(receipt).toMatchObject({ status: 'unavailable', code: 'decoder-unavailable' });
    expect(finalExportVerificationMessage(receipt)).toBe(
      'Final MP4 requires browser verification (decoder-unavailable).',
    );
    expect(error.message).toBe('Final MP4 requires browser verification (decoder-unavailable).');
    expect(error.message).not.toMatch(/key|blob|path|url|provider/i);
  });

  it('rejects a fabricated persisted receipt instead of trusting arbitrary localStorage data', () => {
    expect(
      isFinalExportVerificationReceipt({
        verifierVersion: 'joy-final-encoded-export-verifier-v1',
        decoderVersion,
        checkedAt,
        status: 'verified',
        scope: 'decoded-final-encoded-export',
        facts: {
          container: 'mp4',
          width: 1080,
          height: 1920,
          durationUs: 3_000_000,
          videoStreamCount: 1,
          audioStreamCount: 1,
          presentationFrameCount: 90,
        },
        checkKinds: ['made-up-check'],
      }),
    ).toBe(false);
  });
});
