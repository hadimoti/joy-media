import { describe, expect, it } from 'vitest';
import { ObservationResourceScheduler } from './resource-scheduler.js';
import {
  createSourceObservationFrame,
  estimateObservationFrameWorkingSetBytes,
  ObservationResourceBackpressureError,
  ObservationSampleError,
} from './browser-sample-decoder.js';

const ASSET_DIGEST = 'a'.repeat(64);

function sample(
  overrides: Partial<{
    microsecondTimestamp: number;
    microsecondDuration: number;
    displayWidth: number;
    displayHeight: number;
  }> = {},
) {
  let closeCalls = 0;
  return {
    sample: {
      microsecondTimestamp: 1_500_000,
      microsecondDuration: 33_333,
      displayWidth: 160,
      displayHeight: 90,
      close: () => {
        closeCalls += 1;
      },
      ...overrides,
    },
    closeCalls: () => closeCalls,
  };
}

function scheduler(maxWorkingSetBytes = 1_000_000) {
  return new ObservationResourceScheduler({ maxWorkingSetBytes, maxInFlight: 2 });
}

describe('browser sample observation adapter', () => {
  it('uses the decoder timestamp and presentation index for an opaque evidence identity', () => {
    const fixture = sample();
    const resources = scheduler();
    const frame = createSourceObservationFrame({
      assetDigest: ASSET_DIGEST,
      streamId: 'video-0',
      presentationIndex: 7,
      sample: fixture.sample,
      scheduler: resources,
      epoch: 3,
    });

    expect(frame.actualTimeUs).toBe(1_500_000);
    expect(frame.identity).toMatchObject({
      presentationIndex: 7,
      ptsTicks: '1500000',
      timebaseNumerator: 1,
      timebaseDenominator: 1_000_000,
      sourceTimeUs: 1_500_000,
      durationUs: 33_333,
    });
    expect(resources.snapshot()).toMatchObject({ activeCount: 1, workingSetBytes: 115_200 });

    frame.close();
    frame.close();
    expect(fixture.closeCalls()).toBe(1);
    expect(resources.snapshot()).toMatchObject({ activeCount: 0, workingSetBytes: 0 });
  });

  it('fails closed and releases the decoder sample when the working-set budget rejects it', () => {
    const fixture = sample();
    expect(() =>
      createSourceObservationFrame({
        assetDigest: ASSET_DIGEST,
        streamId: 'video-0',
        presentationIndex: 0,
        sample: fixture.sample,
        scheduler: scheduler(1),
        epoch: 0,
      }),
    ).toThrow(ObservationResourceBackpressureError);
    expect(fixture.closeCalls()).toBe(1);
  });

  it('rejects unsafe decoder metadata instead of creating an inferred frame', () => {
    const fixture = sample({ microsecondTimestamp: -1 });
    expect(() =>
      createSourceObservationFrame({
        assetDigest: ASSET_DIGEST,
        streamId: 'video-0',
        presentationIndex: 0,
        sample: fixture.sample,
        scheduler: scheduler(),
        epoch: 0,
      }),
    ).toThrow(ObservationSampleError);
    expect(fixture.closeCalls()).toBe(1);
  });

  it('accounts for decoded RGBA and one transferable copy without overflowing', () => {
    expect(estimateObservationFrameWorkingSetBytes(160, 90)).toBe(115_200);
    expect(() => estimateObservationFrameWorkingSetBytes(0, 90)).toThrow(ObservationSampleError);
    expect(() => estimateObservationFrameWorkingSetBytes(Number.MAX_SAFE_INTEGER, 2)).toThrow(
      ObservationSampleError,
    );
  });

  it('fails closed when a decoder cannot materialize a bounded visual artifact', async () => {
    const fixture = sample();
    const frame = createSourceObservationFrame({
      assetDigest: ASSET_DIGEST,
      streamId: 'video-0',
      presentationIndex: 0,
      sample: fixture.sample,
      scheduler: scheduler(),
      epoch: 0,
    });
    await expect(
      frame.createThumbnail({
        maxWidth: 320,
        maxHeight: 180,
        maxBytes: 512 * 1024,
      }),
    ).rejects.toMatchObject({
      code: 'unsupported-artifact',
    });
    frame.close();
  });

  it('does not allow a released source frame to produce a late artifact', async () => {
    const fixture = sample();
    const frame = createSourceObservationFrame({
      assetDigest: ASSET_DIGEST,
      streamId: 'video-0',
      presentationIndex: 0,
      sample: fixture.sample,
      scheduler: scheduler(),
      epoch: 0,
    });
    frame.close();
    await expect(
      frame.createThumbnail({
        maxWidth: 320,
        maxHeight: 180,
        maxBytes: 512 * 1024,
      }),
    ).rejects.toMatchObject({ code: 'frame-closed' });
  });
});
