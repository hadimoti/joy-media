import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BoundedPollingLoop,
  MAX_POLL_BACKOFF_MS,
  VISIBLE_POLL_INTERVAL_MS,
} from './bounded-polling.js';

afterEach(() => vi.useRealTimers());

describe('BoundedPollingLoop', () => {
  it('uses a 10-second visible cadence after a successful request', async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue(undefined);
    const loop = new BoundedPollingLoop(poll);

    loop.start();
    await vi.runAllTicks();
    expect(poll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(VISIBLE_POLL_INTERVAL_MS - 1);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it('pauses fully while hidden and refreshes as soon as it is foregrounded', async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue(undefined);
    const loop = new BoundedPollingLoop(poll);

    loop.start();
    await vi.runAllTicks();
    await loop.setVisible(false);
    await vi.advanceTimersByTimeAsync(MAX_POLL_BACKOFF_MS * 2);
    expect(poll).toHaveBeenCalledTimes(1);

    void loop.setVisible(true);
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it('backs off failed requests and caps retries at one minute', async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockRejectedValue(new Error('offline'));
    const loop = new BoundedPollingLoop(poll);

    loop.start();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(VISIBLE_POLL_INTERVAL_MS * 2 - 1);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(MAX_POLL_BACKOFF_MS);
    expect(poll).toHaveBeenCalledTimes(3);
    loop.stop();
  });

  it('never overlaps refreshes and runs one requested follow-up after settlement', async () => {
    let resolveRequest: (() => void) | undefined;
    const poll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const loop = new BoundedPollingLoop(poll);

    loop.start();
    await Promise.resolve();
    const first = loop.refresh();
    const second = loop.refresh();
    expect(first).toBe(second);
    expect(poll).toHaveBeenCalledTimes(1);

    resolveRequest?.();
    await first;
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it('drops a queued follow-up when the document becomes hidden', async () => {
    let resolveRequest: (() => void) | undefined;
    const poll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const loop = new BoundedPollingLoop(poll);

    loop.start();
    await Promise.resolve();
    const inFlight = loop.refresh();
    await loop.setVisible(false);
    resolveRequest?.();
    await inFlight;
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(1);

    void loop.setVisible(true);
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(2);
    loop.stop();
  });
});
