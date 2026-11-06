import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSourceFrameTiming, readSourceFrameTimingWithin } from './export-source-frame.js';

const events = vi.hoisted(() => ({
  log: [] as string[],
  timeResolution: 1000,
  stallTrack: false,
  onTrackRead: undefined as (() => void) | undefined,
}));

vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BlobSource: class {},
  EncodedPacketSink: class {
    packets() {
      // Out of order on purpose: the reader sorts them.
      return (async function* () {
        yield { timestamp: 0.033 };
        yield { timestamp: 0 };
      })();
    }
  },
  Input: class {
    async getPrimaryVideoTrack() {
      // A track read that never settles, to test cancellation.
      if (events.stallTrack) {
        events.onTrackRead?.();
        await new Promise<never>(() => undefined);
      }
      return {
        getTimeResolution: async () => events.timeResolution,
        computePacketStats: async () => {
          // Statistics take a turn of the event loop, as a real demuxer read does.
          await new Promise((resolve) => setTimeout(resolve, 0));
          events.log.push('stats');
          return { averagePacketRate: 30 };
        },
      };
    }
    dispose() {
      events.log.push('dispose');
    }
  },
}));

beforeEach(() => {
  events.log = [];
  events.timeResolution = 1000;
  events.stallTrack = false;
  events.onTrackRead = undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, blob: async () => new Blob([]) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readSourceFrameTiming', () => {
  it('keeps the input open until the packet statistics have been read', async () => {
    const timing = await readSourceFrameTiming('blob:clip', new AbortController().signal);
    expect(timing).toEqual({
      frameDurationUs: 1_000_000 / 30,
      toleranceUs: 500,
      storedFrameUs: [0, 33_000],
    });
    // Disposing first would cancel the statistics read and return no timing at all.
    expect(events.log).toEqual(['stats', 'dispose']);
  });

  it('throws an AbortError, not a timing, when cancelled while the track is read', async () => {
    events.stallTrack = true;
    // Abort only once the track read has started, so the stall is what the cancel interrupts.
    const started = new Promise<void>((resolve) => {
      events.onTrackRead = resolve;
    });
    const controller = new AbortController();
    const pending = readSourceFrameTiming('blob:clip', controller.signal);
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(events.log).toEqual(['dispose']);
  });

  it('gives up on a timing read that stalls past its time limit, keeping the nominal seeks', async () => {
    events.stallTrack = true;
    const timing = await readSourceFrameTimingWithin('blob:clip', new AbortController().signal, 20);
    expect(timing).toBeUndefined();
  });

  it('throws an AbortError when the export was cancelled before the bounded read started', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readSourceFrameTimingWithin('blob:clip', controller.signal, 60_000),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('throws an AbortError when the export is cancelled during a bounded timing read', async () => {
    events.stallTrack = true;
    const controller = new AbortController();
    const pending = readSourceFrameTimingWithin('blob:clip', controller.signal, 60_000);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps the frame length with no tolerance when the resolution cannot be read', async () => {
    // A track that reports no resolution gets the exact lookup, but keeps its frame length.
    events.timeResolution = 0;
    const timing = await readSourceFrameTiming('blob:clip', new AbortController().signal);
    // No resolution means no table: the seek keeps the nominal frames.
    expect(timing).toEqual({ frameDurationUs: 1_000_000 / 30, toleranceUs: 0 });
  });
});
