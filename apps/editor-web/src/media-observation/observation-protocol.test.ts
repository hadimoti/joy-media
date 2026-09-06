import { describe, expect, it } from 'vitest';
import {
  assertObservationWorkerRequest,
  assertObservationWorkerResponse,
  DEFAULT_OBSERVATION_THUMBNAIL_BOUNDS,
  isObservationWorkerResponse,
} from './observation-protocol.js';

const identity = {
  assetDigest: 'a'.repeat(64),
  streamId: 'video-0',
  presentationIndex: 2,
  ptsTicks: '66666',
  timebaseNumerator: 1,
  timebaseDenominator: 1_000_000,
  sourceTimeUs: 66_666,
  durationUs: 33_333,
} as const;

const frameId = `source-frame:v1:${identity.assetDigest}:video-0:2:66666:timebase-1-1000000`;

describe('observation worker protocol', () => {
  it('accepts only a bounded trusted Blob decode request', () => {
    expect(() =>
      assertObservationWorkerRequest({
        type: 'decode-range',
        jobId: 'observation-1',
        assetDigest: identity.assetDigest,
        streamId: identity.streamId,
        source: new Blob(['fixture'], { type: 'video/mp4' }),
        epoch: 1,
        range: { startUs: 0, endUs: 100_000 },
        thumbnail: DEFAULT_OBSERVATION_THUMBNAIL_BOUNDS,
      }),
    ).not.toThrow();
  });

  it('rejects raw URLs and unexpected fields rather than letting a worker fetch media', () => {
    expect(() =>
      assertObservationWorkerRequest({
        type: 'decode-range',
        jobId: 'observation-1',
        assetDigest: identity.assetDigest,
        streamId: identity.streamId,
        source: new Blob(['fixture']),
        sourceUrl: 'https://untrusted.invalid/media.mp4',
        epoch: 1,
        range: { startUs: 0, endUs: 100_000 },
        thumbnail: DEFAULT_OBSERVATION_THUMBNAIL_BOUNDS,
      }),
    ).toThrow(/unsupported fields/);
  });

  it('accepts only a frame whose canonical identity, timing, and bounded thumbnail agree', () => {
    const thumbnail = new Blob(['thumbnail'], { type: 'image/jpeg' });
    const response = {
      type: 'frame',
      jobId: 'observation-1',
      sequence: 0,
      frame: {
        id: frameId,
        identity,
        actualTimeUs: 66_666,
        durationUs: 33_333,
        presentationIndex: 2,
        width: 1920,
        height: 1080,
        thumbnail: {
          blob: thumbnail,
          width: 320,
          height: 180,
          byteLength: thumbnail.size,
          mimeType: 'image/jpeg',
        },
      },
    } as const;
    expect(() => assertObservationWorkerResponse(response)).not.toThrow();
    expect(isObservationWorkerResponse(response)).toBe(true);
  });

  it('fails closed when a worker response swaps an identity or lies about thumbnail bytes', () => {
    const thumbnail = new Blob(['thumbnail'], { type: 'image/jpeg' });
    const response = {
      type: 'frame',
      jobId: 'observation-1',
      sequence: 0,
      frame: {
        id: 'source-frame:v1:not-the-real-identity',
        identity,
        actualTimeUs: 66_666,
        durationUs: 33_333,
        presentationIndex: 2,
        width: 1920,
        height: 1080,
        thumbnail: {
          blob: thumbnail,
          width: 320,
          height: 180,
          byteLength: thumbnail.size + 1,
          mimeType: 'image/jpeg',
        },
      },
    } as const;
    expect(() => assertObservationWorkerResponse(response)).toThrow();
    expect(isObservationWorkerResponse(response)).toBe(false);
  });
});
