import type { PreviewFrameRate } from '../preview-quality.js';

export interface MonitorPerformanceStats {
  readonly fps: number;
  readonly droppedFrames: number;
}

export interface MonitorPerformanceTracker {
  readonly windowStartedAtMs: number;
  readonly renderedFrames: number;
  readonly droppedFrames: number;
  readonly lastPlayheadUs?: number;
}

export function createMonitorPerformanceTracker(nowMs = 0): MonitorPerformanceTracker {
  return { windowStartedAtMs: nowMs, renderedFrames: 0, droppedFrames: 0 };
}

/** Record a distinct rendered playhead frame and report once per second. */
export function recordMonitorFrame(
  tracker: MonitorPerformanceTracker,
  playheadUs: number,
  nowMs: number,
  frameRate: PreviewFrameRate,
): { readonly tracker: MonitorPerformanceTracker; readonly stats?: MonitorPerformanceStats } {
  if (!Number.isFinite(playheadUs) || !Number.isFinite(nowMs)) return { tracker };
  if (tracker.lastPlayheadUs === playheadUs) return { tracker };

  if (tracker.lastPlayheadUs !== undefined && playheadUs < tracker.lastPlayheadUs) {
    return {
      tracker: {
        windowStartedAtMs: nowMs,
        renderedFrames: 0,
        droppedFrames: 0,
        lastPlayheadUs: playheadUs,
      },
    };
  }

  if (tracker.lastPlayheadUs === undefined) {
    return {
      tracker: {
        windowStartedAtMs: nowMs,
        renderedFrames: 0,
        droppedFrames: tracker.droppedFrames,
        lastPlayheadUs: playheadUs,
      },
    };
  }

  const frameDurationUs = (1_000_000 * frameRate.den) / frameRate.num;
  const expectedFrames = !(frameDurationUs > 0)
    ? 1
    : Math.max(1, Math.round((playheadUs - tracker.lastPlayheadUs) / frameDurationUs));
  const nextTracker: MonitorPerformanceTracker = {
    windowStartedAtMs: tracker.windowStartedAtMs,
    renderedFrames: tracker.renderedFrames + 1,
    droppedFrames: tracker.droppedFrames + expectedFrames - 1,
    lastPlayheadUs: playheadUs,
  };
  const elapsedMs = nowMs - nextTracker.windowStartedAtMs;
  if (!(elapsedMs >= 1000)) return { tracker: nextTracker };

  return {
    tracker: {
      windowStartedAtMs: nowMs,
      renderedFrames: 0,
      droppedFrames: nextTracker.droppedFrames,
      lastPlayheadUs: playheadUs,
    },
    stats: {
      fps: Math.round((nextTracker.renderedFrames * 1000) / elapsedMs),
      droppedFrames: nextTracker.droppedFrames,
    },
  };
}
