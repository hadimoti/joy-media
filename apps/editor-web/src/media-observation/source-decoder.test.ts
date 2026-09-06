import { describe, expect, it } from 'vitest';
import { ObservationResourceScheduler } from './resource-scheduler.js';
import { createBrowserSourceObservationDecoder } from './source-decoder.js';

const ASSET_DIGEST = 'b'.repeat(64);

function decoder() {
  return createBrowserSourceObservationDecoder({
    assetDigest: ASSET_DIGEST,
    streamId: 'video-0',
    source: new Blob([new Uint8Array([0])], { type: 'video/mp4' }),
    scheduler: new ObservationResourceScheduler({ maxWorkingSetBytes: 1_000_000, maxInFlight: 1 }),
    epoch: 0,
  });
}

describe('browser source observation decoder', () => {
  it('rejects invalid half-open ranges before opening a media input', async () => {
    const iterable = decoder().frames({ startUs: 2, endUs: 2 }, new AbortController().signal);
    const scan = iterable[Symbol.asyncIterator]();
    await expect(scan.next()).rejects.toMatchObject({ code: 'invalid-range' });
  });

  it('fails closed when an abort arrives before a scan starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const iterable = decoder().frames({ startUs: 0, endUs: 1 }, controller.signal);
    const scan = iterable[Symbol.asyncIterator]();
    await expect(scan.next()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('does not reopen a decoder after explicit closure', async () => {
    const value = decoder();
    value.close();
    const iterable = value.frames({ startUs: 0, endUs: 1 }, new AbortController().signal);
    const scan = iterable[Symbol.asyncIterator]();
    await expect(scan.next()).rejects.toMatchObject({ code: 'closed' });
  });
});
