// @vitest-environment jsdom
import { act, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { emptySpikeProject, makeVideoClip, withClips } from '@joy-media/test-fixtures';
import { TimelinePanel } from './TimelinePanel.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('TimelinePanel media performance', () => {
  it('measures scrub commits on a 200-clip fixture and enforces an optional baseline budget', async () => {
    class ResizeObserverStub {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    const project = withClips(
      emptySpikeProject({ trackCount: 1, durationUs: 200_000_000 }),
      'track-0',
      Array.from({ length: 200 }, (_, index) =>
        makeVideoClip(`scrub-${index}`, index * 1_000_000, 1_000_000),
      ),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const noop = vi.fn();
    const durationsMs: number[] = [];
    const baselineMs = Number(process.env.TD13_BASELINE_MS);
    const recordCommit = (_id: string, phase: string, actualDuration: number) => {
      if (phase === 'update') durationsMs.push(actualDuration);
    };

    const render = (playheadUs: number) => (
      <Profiler id="timeline-scrub" onRender={recordCommit}>
        <TimelinePanel
          project={project}
          playheadUs={playheadUs}
          playing={false}
          selectedIds={[]}
          viewport={{ originUs: 0, pixelsPerSecond: 280 }}
          onViewportChange={noop}
          autoFit={false}
          onAutoFitChange={noop}
          onTogglePlayback={noop}
          onSeek={noop}
          onToggleSelection={noop}
          onClearSelection={noop}
          onDispatch={noop}
        />
      </Profiler>
    );

    try {
      await act(async () => root.render(render(0)));
      expect(container.querySelectorAll('.timeline-clip')).toHaveLength(200);
      for (const playheadUs of [33_333, 66_666, 99_999, 133_332, 166_665]) {
        await act(async () => root.render(render(playheadUs)));
      }

      const sorted = [...durationsMs].sort((left, right) => left - right);
      const medianMs = sorted[Math.floor(sorted.length / 2)]!;
      console.info(
        `[T-D13] 200-clip scrub median React commit: ${medianMs.toFixed(3)} ms (${durationsMs.length} updates)`,
      );
      expect(durationsMs).toHaveLength(5);
      expect(Number.isFinite(medianMs)).toBe(true);
      if (Number.isFinite(baselineMs) && baselineMs > 0) {
        expect(medianMs).toBeLessThanOrEqual(baselineMs * 1.1);
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});
