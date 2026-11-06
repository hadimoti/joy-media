/**
 * How a source's frame times are read: the average frame length, how far a frame's stored time
 * may sit from its true time (see `timestampToleranceUs`), and, when it could be read, every
 * frame's stored presentation time in microseconds, ascending.
 */
export interface SeekFrameTiming {
  readonly frameDurationUs: number;
  readonly toleranceUs: number;
  readonly storedFrameUs?: readonly number[];
}

/** The part of a mediabunny video track that frame timing needs. */
export interface FrameStatsSource {
  computePacketStats(packetCount: number): Promise<{ readonly averagePacketRate: number }>;
}

/** Marks a read that the export's cancellation ended before it settled. */
export const ABORTED = Symbol('aborted');

/** Throws the AbortError that a cancelled export expects, once `signal` has aborted. */
export function abortIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
}

/** Resolves with `pending`, or throws an AbortError as soon as `signal` aborts. */
export async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let settled: T | typeof ABORTED;
  try {
    settled = await settleOrAbort(pending, signal);
  } catch (error) {
    // A read that failed because the export was cancelled reports the cancellation, not its error.
    abortIfCancelled(signal);
    throw error;
  }
  abortIfCancelled(signal);
  return settled as T;
}

/**
 * Frame timing of a track from its packet rate, with the given tolerance. Resolves `undefined`
 * when the rate is unknown or cannot be read, so the caller keeps seeking to exact source times.
 */
export async function frameTimingOf(
  track: FrameStatsSource,
  toleranceUs: number,
  signal?: AbortSignal,
): Promise<SeekFrameTiming | undefined> {
  try {
    const stats = await settleOrAbort(track.computePacketStats(600), signal);
    if (stats === ABORTED || !(stats.averagePacketRate > 0)) return undefined;
    return { frameDurationUs: 1_000_000 / stats.averagePacketRate, toleranceUs };
  } catch {
    return undefined;
  }
}

/**
 * Waits for `pending`, or for `signal` to abort, whichever comes first. A pending read that never
 * settles therefore cannot hold up a cancelled export. The read itself is left to finish or fail on
 * its own; its result is ignored after an abort.
 */
export function settleOrAbort<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T | typeof ABORTED> {
  if (signal === undefined) return pending;
  if (signal.aborted) {
    pending.catch(() => undefined);
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** mediabunny's seconds-to-microseconds factor (its `SECOND_TO_MICROSECOND_FACTOR`). */
const SECOND_TO_MICROSECOND_FACTOR = 1e6 * (1 + Number.EPSILON);

/**
 * Every decoded frame's presentation time, in microseconds, ascending, from packets read with
 * metadata only. The decoder rounds each packet time to the track's time resolution before it
 * truncates to microseconds (mediabunny `finalizeAndEmitSample`), so this does the same, and the
 * table holds the numbers the forward lookup compares. Resolves `undefined` when the packets cannot
 * be read, the resolution is unknown, or none are found. Stops early when `signal` aborts.
 */
export async function frameTimesOf(
  openPackets: () => AsyncIterable<{ readonly timestamp: number }>,
  timeResolution: number,
  signal?: AbortSignal,
  microsecondChunks = decodesFromMicrosecondChunks(),
): Promise<number[] | undefined> {
  if (!(timeResolution > 0)) return undefined;
  const times: number[] = [];
  let iterator: AsyncIterator<{ readonly timestamp: number }> | undefined;
  try {
    iterator = openPackets()[Symbol.asyncIterator]();
    for (;;) {
      const step = await settleOrAbort(iterator.next(), signal);
      if (step === ABORTED) return undefined;
      if (step.done === true) break;
      // WebKit's decoder path hands back the chunk's microsecond timestamp; Chromium's path keeps
      // the packet's own time. Each is rounded to the track resolution, then truncated.
      const seconds = microsecondChunks
        ? Math.trunc(SECOND_TO_MICROSECOND_FACTOR * step.value.timestamp) / 1_000_000
        : step.value.timestamp;
      const rounded = Math.round(seconds * timeResolution) / timeResolution;
      times.push(Math.trunc(SECOND_TO_MICROSECOND_FACTOR * rounded));
    }
  } catch {
    return undefined;
  } finally {
    // Not awaited: a stalled read would hold the cancelled export here. The iterator is released
    // as soon as its pending read settles.
    try {
      void iterator?.return?.()?.catch(() => undefined);
    } catch {
      // A custom iterator whose return() throws has nothing left to release.
    }
  }
  if (times.length === 0) return undefined;
  return times.sort((a, b) => a - b);
}

/**
 * Whether this browser's decoder path hands frame times back as microsecond chunk timestamps
 * (mediabunny's WebKit path). The same test mediabunny uses for its `isWebKit`. Chromium and
 * Electron, the desktop app's runtime, keep the packet's own time instead.
 */
export function decodesFromMicrosecondChunks(): boolean {
  if (typeof navigator === 'undefined') return false;
  const vendor = (navigator as { vendor?: string }).vendor ?? '';
  const agent = navigator.userAgent;
  return (
    /apple/i.test(vendor) ||
    (/AppleWebKit/.test(agent) && !/Chrome/.test(agent)) ||
    /\b(iPad|iPhone|iPod)\b/.test(agent)
  );
}

/**
 * Half a storage unit of a container's timestamps, in microseconds. WebM and Matroska store whole
 * milliseconds (resolution 1000: 500 us), MP4 stores its track timescale (15360 for the C7
 * fixture: about 33 us). A frame stored a rounding error later than a requested time is still on
 * screen at that time, so the lookup treats it as on screen. Without this, output frame 2 at 30 fps
 * (66.67 ms) shows frame 1 when frame 2 is stored as 67 ms: every third frame repeated (C8 and C9).
 */
export function timestampToleranceUs(timeResolution: number): number {
  return timeResolution > 0 ? 500_000 / timeResolution : 0;
}

/**
 * Where to seek a detached video so that the frame on screen is the source frame that holds
 * `sourceUs`, from nominal frame boundaries (k times the average frame length). The seek goes to
 * the middle of that frame. A seek to a time a few microseconds short of the next frame's edge can
 * show the next frame instead: on the reversed-clip export, frames whose index is a multiple of 3
 * came out one frame late (C11 fixture, 30 fps). Used when no stored frame times are known.
 *
 * `toleranceUs` applies the same rule as the forward lookup: a time within the tolerance before a
 * frame's start belongs to that frame.
 */
export function frameCentreSeekUs(
  sourceUs: number,
  frameDurationUs: number,
  toleranceUs = 0,
): number {
  const index = Math.max(0, Math.floor((sourceUs + toleranceUs) / frameDurationUs + 1e-6));
  return (index + 0.5) * frameDurationUs;
}

/**
 * Where to seek so that the frame on screen is the STORED frame the forward lookup shows at
 * `sourceUs`: the last stored time at or before `sourceUs + toleranceUs`. The seek goes to the
 * middle of that frame's stored interval, which the browser shows as that frame whatever the
 * rounding of the stored times. Both paths therefore pick the same frame by construction.
 */
export function storedFrameCentreSeekUs(
  sourceUs: number,
  storedFrameUs: readonly number[],
  frameDurationUs: number,
  toleranceUs = 0,
): number {
  const target = sourceUs + toleranceUs;
  // Binary search for the last stored time at or before the target (the first frame when none is).
  let low = 0;
  let high = storedFrameUs.length - 1;
  let index = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (storedFrameUs[middle]! <= target) {
      index = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const start = storedFrameUs[index]!;
  const end = storedFrameUs[index + 1] ?? start + frameDurationUs;
  return (start + end) / 2;
}

/**
 * The seek time for a source time, given the clip's frame timing: the stored-frame centre when
 * the stored times are known, otherwise the nominal frame centre, otherwise the exact time.
 */
export function seekUsForSource(sourceUs: number, timing: SeekFrameTiming | undefined): number {
  if (timing === undefined) return sourceUs;
  if (timing.storedFrameUs !== undefined && timing.storedFrameUs.length > 0) {
    return storedFrameCentreSeekUs(
      sourceUs,
      timing.storedFrameUs,
      timing.frameDurationUs,
      timing.toleranceUs,
    );
  }
  return frameCentreSeekUs(sourceUs, timing.frameDurationUs, timing.toleranceUs);
}
