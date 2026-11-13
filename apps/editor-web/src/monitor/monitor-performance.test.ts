import { describe, expect, it } from 'vitest';
import {
  createMonitorPerformanceTracker,
  recordMonitorFrame,
} from './monitor-performance.js';

describe('monitor performance sampling', () => {
  it('reports rendered frames per second and accumulated dropped frames', () => {
    const frameRate = { num: 30, den: 1 };
    let tracker = createMonitorPerformanceTracker(0);
    tracker = recordMonitorFrame(tracker, 0, 0, frameRate).tracker;
    tracker = recordMonitorFrame(tracker, 500_000, 500, frameRate).tracker;
    const result = recordMonitorFrame(tracker, 1_000_000, 1_000, frameRate);

    expect(result.stats).toEqual({ fps: 2, droppedFrames: 28 });
    expect(result.tracker.droppedFrames).toBe(28);
  });

  it('ignores duplicate playhead paints and starts a fresh window after a seek', () => {
    const frameRate = { num: 30, den: 1 };
    const tracker = createMonitorPerformanceTracker(0);
    const first = recordMonitorFrame(tracker, 0, 0, frameRate);
    const duplicate = recordMonitorFrame(first.tracker, 0, 50, frameRate);
    const progressed = recordMonitorFrame(duplicate.tracker, 500_000, 500, frameRate);
    const seek = recordMonitorFrame(progressed.tracker, 0, 600, frameRate);

    expect(duplicate.tracker).toBe(first.tracker);
    expect(seek.tracker).not.toBe(progressed.tracker);
    expect(seek.tracker.lastPlayheadUs).toBe(0);
    expect(seek.tracker.droppedFrames).toBe(0);
  });
});
