/**
 * A forward-only cursor over decoded video frames.
 *
 * Export asks for one source frame per output frame, at times that only move forward. Seeking a
 * video element for every frame makes the browser jump back to the previous keyframe and decode
 * forward again each time (seconds of video per keyframe), which made an export of a long clip run
 * at about half of real time. The cursor instead walks the decoder's frames in presentation order,
 * once, and hands out the frame that is on screen at each requested time.
 */

/** One decoded frame as the cursor sees it. */
export interface CursorFrame {
  /** Presentation time of the frame in microseconds. */
  readonly timestampUs: number;
  /** Releases the decoded picture. The cursor calls it exactly once per frame it received. */
  close(): void;
}

export interface SequentialFrameCursorOptions {
  /**
   * How many times a backward request may restart the decoder at the new time before the cursor
   * gives up on the clip. A transition makes the incoming clip jump back once, so a handful is
   * normal; a clip that jumps back every few frames is better served by seeking.
   */
  readonly maxRestarts?: number;
  /**
   * A forward request further ahead than this restarts the decoder at the new time instead of
   * decoding every frame in between; jumping to the nearest keyframe is cheaper for a long gap.
   * It counts against `maxRestarts` like a backward request. Default: never.
   */
  readonly maxForwardGapUs?: number;
  /**
   * A frame whose timestamp is at most this far after the requested time still counts as on
   * screen at that time. Containers store timestamps at their own resolution: WebM in whole
   * milliseconds, so frame 2 at 30 fps (66.67 ms) is stored as 67 ms. Without a tolerance the
   * lookup then shows the frame before it, and every third output frame repeats its predecessor
   * (C8 and C9 matrix fixtures, 6 Nov). Default: 0, an exact lookup.
   */
  readonly lookupToleranceUs?: number;
}

export interface SequentialFrameCursor<F extends CursorFrame> {
  /**
   * The frame that is on screen at `timeUs`: the last frame whose timestamp is at or before the
   * time, or the first frame when the time is before it. The frame stays valid until the next
   * call. Resolves `undefined` when the clip should be served some other way: the request went
   * backwards and the restart budget is spent, or the source has no frames at all.
   */
  frameAt(timeUs: number): Promise<F | undefined>;
  /**
   * Stops the decoder and drops the frames it holds, but keeps the cursor usable: the next request
   * opens a new decoder there. For a clip that has ended and may not be needed again soon. While a
   * request is pending the frame it is about to return stays valid, so the release takes effect
   * when the next request starts instead.
   */
  release(): void;
  /** Releases everything and stops the decoder for good. Safe to call twice. */
  close(): void;
}

/**
 * `open` starts a decoder at `startUs` and returns its frames in presentation order, beginning
 * with the frame on screen at `startUs`. It is called on the first request, and again after a
 * restart or a release.
 */
export function createSequentialFrameCursor<F extends CursorFrame>(
  open: (startUs: number) => AsyncIterator<F>,
  options: SequentialFrameCursorOptions = {},
): SequentialFrameCursor<F> {
  const maxRestarts = options.maxRestarts ?? 0;
  const maxForwardGapUs = options.maxForwardGapUs ?? Number.POSITIVE_INFINITY;
  const lookupToleranceUs = options.lookupToleranceUs ?? 0;
  let iterator: AsyncIterator<F> | undefined;
  let current: F | undefined;
  let upcoming: F | undefined;
  let exhausted = false;
  let closed = false;
  let busy = false;
  let releaseRequested = false;
  let restarts = 0;
  let lastRequestUs: number | undefined;

  const stopDecoder = () => {
    current?.close();
    upcoming?.close();
    current = undefined;
    upcoming = undefined;
    const finished = iterator;
    iterator = undefined;
    exhausted = false;
    lastRequestUs = undefined;
    // A decoder that fails while it is being stopped has nothing left to report.
    void finished?.return?.()?.catch(() => undefined);
  };

  const pull = async (): Promise<F | undefined> => {
    if (exhausted || iterator === undefined) return undefined;
    const result = await iterator.next();
    if (result.done === true) {
      exhausted = true;
      return undefined;
    }
    if (closed) {
      // The export was cancelled while this frame was being decoded.
      result.value.close();
      return undefined;
    }
    return result.value;
  };

  return {
    async frameAt(timeUs) {
      if (closed) return undefined;
      if (busy) throw new Error('A sequential frame cursor serves one request at a time');
      busy = true;
      try {
        if (releaseRequested) {
          releaseRequested = false;
          stopDecoder();
        }
        // Same tolerance as the lookup below: a frame within it is still on screen at `timeUs`, so
        // a request that only steps back inside that window does not restart the decoder.
        const wentBackwards =
          lastRequestUs !== undefined &&
          timeUs < lastRequestUs &&
          current !== undefined &&
          timeUs + lookupToleranceUs < current.timestampUs;
        const jumpedFarAhead =
          current !== undefined && timeUs - current.timestampUs > maxForwardGapUs;
        if (wentBackwards || jumpedFarAhead) {
          if (restarts >= maxRestarts) return undefined;
          restarts += 1;
          stopDecoder();
        }
        if (iterator === undefined) iterator = open(timeUs);
        lastRequestUs = timeUs;

        if (current === undefined) {
          current = upcoming ?? (await pull());
          upcoming = undefined;
          if (current === undefined) return undefined;
        }
        for (;;) {
          const next = upcoming ?? (await pull());
          if (closed) return undefined;
          if (next === undefined) break;
          if (next.timestampUs > timeUs + lookupToleranceUs) {
            upcoming = next;
            break;
          }
          current.close();
          current = next;
          upcoming = undefined;
        }
        return current;
      } finally {
        busy = false;
      }
    },
    release() {
      if (closed) return;
      if (busy) {
        releaseRequested = true;
        return;
      }
      stopDecoder();
    },
    close() {
      if (closed) return;
      closed = true;
      stopDecoder();
    },
  };
}
