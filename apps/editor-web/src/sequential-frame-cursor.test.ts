import { describe, expect, it } from 'vitest';
import { createSequentialFrameCursor, type CursorFrame } from './sequential-frame-cursor.js';

interface TestFrame extends CursorFrame {
  readonly label: string;
  readonly closeCount: () => number;
}

/** Frames every `stepUs` starting at `firstUs`, with a record of how often each is closed. */
function makeSource(count: number, stepUs: number, firstUs = 0) {
  const frames: TestFrame[] = [];
  for (let index = 0; index < count; index++) {
    let closed = 0;
    frames.push({
      timestampUs: firstUs + index * stepUs,
      label: `f${index}`,
      close: () => {
        closed += 1;
      },
      closeCount: () => closed,
    });
  }
  const log = { opens: [] as number[], pulled: 0, returned: false };
  const open = (startUs: number): AsyncIterator<TestFrame> => {
    log.opens.push(startUs);
    // The first frame yielded is the one on screen at the start time, as a real decoder does.
    let index = 0;
    while (index + 1 < frames.length && frames[index + 1]!.timestampUs <= startUs) index += 1;
    return {
      next: async () => {
        const frame = frames[index];
        if (frame === undefined) return { done: true, value: undefined };
        index += 1;
        log.pulled += 1;
        return { done: false, value: frame };
      },
      return: async () => {
        log.returned = true;
        return { done: true, value: undefined };
      },
    };
  };
  return { frames, log, open };
}

describe('createSequentialFrameCursor', () => {
  it('hands out the frame on screen at each time and opens the decoder once', async () => {
    const { open, log } = makeSource(10, 100_000);
    const cursor = createSequentialFrameCursor(open);
    // Output at 30 fps over a 10 fps source: several output frames show the same source frame.
    const seen: string[] = [];
    for (let index = 0; index < 9; index++) {
      const frame = await cursor.frameAt(Math.floor((index * 1_000_000) / 30));
      seen.push(frame?.label ?? 'none');
    }
    // Output frame 3 is at exactly 100 ms, which is when source frame f1 starts.
    expect(seen).toEqual(['f0', 'f0', 'f0', 'f1', 'f1', 'f1', 'f2', 'f2', 'f2']);
    expect(log.opens).toEqual([0]);
  });

  it('closes each frame it moves past, once, and keeps at most two frames decoded', async () => {
    const { open, frames, log } = makeSource(6, 100_000);
    const cursor = createSequentialFrameCursor(open);
    await cursor.frameAt(0);
    await cursor.frameAt(450_000);
    expect(frames.map((frame) => frame.closeCount())).toEqual([1, 1, 1, 1, 0, 0]);
    // current (f4) plus the look-ahead (f5) are the only two held; nothing beyond was pulled.
    expect(log.pulled).toBe(6);
    cursor.close();
    expect(frames.map((frame) => frame.closeCount())).toEqual([1, 1, 1, 1, 1, 1]);
    cursor.close();
    expect(frames.map((frame) => frame.closeCount())).toEqual([1, 1, 1, 1, 1, 1]);
    expect(log.returned).toBe(true);
  });

  it('starts at the first requested time, not at the start of the file', async () => {
    const { open, log } = makeSource(100, 100_000);
    const cursor = createSequentialFrameCursor(open);
    const frame = await cursor.frameAt(5_000_000);
    expect(frame?.label).toBe('f50');
    expect(log.opens).toEqual([5_000_000]);
  });

  it('holds the last frame after the source ends', async () => {
    const { open } = makeSource(3, 100_000);
    const cursor = createSequentialFrameCursor(open);
    expect((await cursor.frameAt(250_000))?.label).toBe('f2');
    expect((await cursor.frameAt(9_000_000))?.label).toBe('f2');
    expect((await cursor.frameAt(9_500_000))?.label).toBe('f2');
  });

  it('shows the first frame for a time before the first frame, and does not call that backwards', async () => {
    const { open } = makeSource(5, 100_000, 200_000);
    const cursor = createSequentialFrameCursor(open);
    expect((await cursor.frameAt(0))?.label).toBe('f0');
    expect((await cursor.frameAt(50_000))?.label).toBe('f0');
    expect((await cursor.frameAt(250_000))?.label).toBe('f0');
    expect((await cursor.frameAt(300_000))?.label).toBe('f1');
  });

  it('asks the caller to fall back when a request goes backwards past the current frame', async () => {
    const { open } = makeSource(10, 100_000);
    const cursor = createSequentialFrameCursor(open);
    expect((await cursor.frameAt(520_000))?.label).toBe('f5');
    expect(await cursor.frameAt(200_000)).toBeUndefined();
    // A rounding step back that is still inside the frame on screen is not a backward request.
    expect((await cursor.frameAt(519_999))?.label).toBe('f5');
    // A step back to before the frame on screen is one.
    expect(await cursor.frameAt(499_999)).toBeUndefined();
    // The cursor itself is still usable going forward.
    expect((await cursor.frameAt(700_000))?.label).toBe('f7');
  });

  it('restarts the decoder at the new time on a backward request while the budget lasts', async () => {
    // A transition makes the incoming clip run ahead, then snap back by the transition length.
    const { open, frames, log } = makeSource(40, 100_000);
    const cursor = createSequentialFrameCursor(open, { maxRestarts: 2 });
    expect((await cursor.frameAt(1_500_000))?.label).toBe('f15');
    expect((await cursor.frameAt(1_600_000))?.label).toBe('f16');
    expect((await cursor.frameAt(500_000))?.label).toBe('f5');
    expect((await cursor.frameAt(600_000))?.label).toBe('f6');
    expect(log.opens).toEqual([1_500_000, 500_000]);
    // Every frame of the first decoder was closed when it was replaced.
    expect(frames.slice(15, 18).map((frame) => frame.closeCount())).toEqual([1, 1, 1]);
    // A second snap back is still inside the budget; a third is not.
    expect((await cursor.frameAt(2_500_000))?.label).toBe('f25');
    expect((await cursor.frameAt(900_000))?.label).toBe('f9');
    expect((await cursor.frameAt(3_000_000))?.label).toBe('f30');
    expect(await cursor.frameAt(100_000)).toBeUndefined();
    // Forward requests keep decoding the same stream; only the two snap-backs reopened it.
    expect(log.opens).toEqual([1_500_000, 500_000, 900_000]);
  });

  it('jumps instead of decoding through a long forward gap, within the same budget', async () => {
    const { open, log } = makeSource(400, 100_000);
    const cursor = createSequentialFrameCursor(open, {
      maxRestarts: 1,
      maxForwardGapUs: 5_000_000,
    });
    expect((await cursor.frameAt(0))?.label).toBe('f0');
    expect((await cursor.frameAt(4_000_000))?.label).toBe('f40');
    expect((await cursor.frameAt(30_000_000))?.label).toBe('f300');
    expect(log.opens).toEqual([0, 30_000_000]);
    // The budget is spent, so a second long jump is handed back to the caller.
    expect(await cursor.frameAt(39_000_000)).toBeUndefined();
  });

  it('reopens after a release without counting it as a restart', async () => {
    const { open, frames, log } = makeSource(40, 100_000);
    const cursor = createSequentialFrameCursor(open, { maxRestarts: 0 });
    expect((await cursor.frameAt(300_000))?.label).toBe('f3');
    cursor.release();
    // Both held frames (the one on screen and the look-ahead) were closed.
    expect(frames.slice(3, 5).map((frame) => frame.closeCount())).toEqual([1, 1]);
    expect(log.returned).toBe(true);
    // The clip is needed again later; that is not a backward request.
    expect((await cursor.frameAt(2_000_000))?.label).toBe('f20');
    expect((await cursor.frameAt(2_100_000))?.label).toBe('f21');
    expect(log.opens).toEqual([300_000, 2_000_000]);
  });

  it('applies a release made during a pending request before the next request, keeping the returned frame valid', async () => {
    const { frames, open, log } = makeSource(10, 100_000);
    let letPullFinish: (() => void) | undefined;
    let slow = false;
    const gated = (startUs: number): AsyncIterator<TestFrame> => {
      const inner = open(startUs);
      return {
        next: async () => {
          if (slow)
            await new Promise<void>((resolve) => {
              letPullFinish = resolve;
            });
          return inner.next();
        },
        return: async () => inner.return?.() ?? { done: true, value: undefined },
      };
    };
    const cursor = createSequentialFrameCursor(gated);
    expect((await cursor.frameAt(0))?.label).toBe('f0');
    slow = true;
    const pending = cursor.frameAt(300_000);
    cursor.release();
    slow = false;
    letPullFinish?.();
    const served = await pending;
    expect(served?.label).toBe('f3');
    // The frame handed to the caller is still open while they use it.
    expect(served?.closeCount()).toBe(0);
    // The next request starts over, and a release is not a restart.
    expect((await cursor.frameAt(800_000))?.label).toBe('f8');
    expect(log.opens).toEqual([0, 800_000]);
    expect(frames[3]?.closeCount()).toBe(1);
  });

  it('resolves undefined for a source with no frames, instead of throwing', async () => {
    const { open } = makeSource(0, 100_000);
    const cursor = createSequentialFrameCursor(open);
    expect(await cursor.frameAt(0)).toBeUndefined();
    expect(await cursor.frameAt(100_000)).toBeUndefined();
  });

  it('releases a frame that finishes decoding after the cursor was closed', async () => {
    let closed = 0;
    let release: (() => void) | undefined;
    const slowFrame: TestFrame = {
      timestampUs: 0,
      label: 'late',
      close: () => {
        closed += 1;
      },
      closeCount: () => closed,
    };
    const cursor = createSequentialFrameCursor<TestFrame>(() => ({
      next: () =>
        new Promise((resolve) => {
          release = () => resolve({ done: false, value: slowFrame });
        }),
    }));
    const pending = cursor.frameAt(0);
    cursor.close();
    release?.();
    expect(await pending).toBeUndefined();
    expect(closed).toBe(1);
  });

  it('refuses two requests at once, since the frame it returns is only valid until the next call', async () => {
    const { open } = makeSource(5, 100_000);
    const cursor = createSequentialFrameCursor(open);
    const first = cursor.frameAt(0);
    await expect(cursor.frameAt(100_000)).rejects.toThrow('one request at a time');
    await first;
  });

  it('survives a decoder that throws while it is being stopped', async () => {
    const { frames } = makeSource(2, 100_000);
    const cursor = createSequentialFrameCursor<TestFrame>(() => {
      let index = 0;
      return {
        next: async () => ({ done: false, value: frames[index++ % 2]! }),
        return: async () => {
          throw new Error('decoder already torn down');
        },
      };
    });
    await cursor.frameAt(0);
    expect(() => cursor.close()).not.toThrow();
  });
});
