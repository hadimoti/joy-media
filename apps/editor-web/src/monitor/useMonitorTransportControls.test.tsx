// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useMonitorTransportControls,
  type MonitorTransportControls,
} from './useMonitorTransportControls.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Monitor transport reverse', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let frames: Array<(now: number) => void> = [];

  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
  });

  it('steps the playhead back in whole microseconds, so every step is accepted', async () => {
    const seek = vi.fn((timeUs: number) => {
      // The playhead refuses anything but a whole, non-negative number (as the app's scheduler does).
      if (!Number.isSafeInteger(timeUs) || timeUs < 0) throw new Error('timeUs must be an integer');
    });
    let controls: MonitorTransportControls | undefined;
    function Probe() {
      controls = useMonitorTransportControls({
        playheadUs: 2_000_000,
        playing: false,
        durationUs: 3_000_000,
        fps: 30,
        seek,
        togglePlayback: () => undefined,
      });
      return null;
    }
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(createElement(Probe)));

    await act(async () => controls?.pressJkl('j'));
    // Frames arrive at fractional millisecond times, as the browser's clock does.
    await act(async () => {
      let now = 1000.37;
      for (let index = 0; index < 6; index += 1) {
        const next = frames.shift();
        next?.(now);
        now += 33.3337;
      }
    });

    expect(seek.mock.calls.length).toBeGreaterThan(1);
    for (const [timeUs] of seek.mock.calls) expect(Number.isSafeInteger(timeUs)).toBe(true);
    const last = seek.mock.calls.at(-1)?.[0] ?? 2_000_000;
    expect(last).toBeLessThan(2_000_000);
  });
});
