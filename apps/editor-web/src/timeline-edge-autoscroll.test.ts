import { describe, expect, it, vi } from 'vitest';
import { createTimelineEdgeAutoScrollLoop } from './timeline-edge-autoscroll.js';

function fakeAnimationFrames() {
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  return {
    callbacks,
    request: vi.fn((callback: FrameRequestCallback) => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    }),
    cancel: vi.fn((id: number) => callbacks.delete(id)),
    flush(timestamp: number) {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(timestamp);
    },
  };
}

describe('timeline edge auto-scroll loop', () => {
  it('repeats scroll frames while the pointer remains in the edge zone', () => {
    const frames = fakeAnimationFrames();
    const scrollAtPointer = vi.fn((clientX: number) => (clientX > 90 ? 12 : undefined));
    const loop = createTimelineEdgeAutoScrollLoop(scrollAtPointer, {
      request: frames.request,
      cancel: frames.cancel,
    });

    loop.move(99, 40);
    expect(frames.callbacks.size).toBe(1);

    frames.flush(16);
    expect(scrollAtPointer).toHaveBeenCalledTimes(1);
    expect(frames.callbacks.size).toBe(1);

    frames.flush(32);
    expect(scrollAtPointer).toHaveBeenCalledTimes(2);
    expect(frames.callbacks.size).toBe(1);

    loop.move(50, 40);
    frames.flush(48);
    expect(scrollAtPointer).toHaveBeenCalledTimes(3);
    expect(frames.callbacks.size).toBe(0);
  });

  it('cancels a scheduled frame when the drag ends', () => {
    const frames = fakeAnimationFrames();
    const scrollAtPointer = vi.fn(() => 12);
    const loop = createTimelineEdgeAutoScrollLoop(scrollAtPointer, {
      request: frames.request,
      cancel: frames.cancel,
    });

    loop.move(99, 40);
    const pendingFrame = [...frames.callbacks.keys()][0]!;
    loop.stop();

    expect(frames.cancel).toHaveBeenCalledWith(pendingFrame);
    expect(frames.callbacks.size).toBe(0);
    frames.flush(16);
    expect(scrollAtPointer).not.toHaveBeenCalled();
  });
});
