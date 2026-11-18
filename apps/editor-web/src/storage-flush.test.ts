import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStorageFlushNotifier } from './storage-flush.js';

describe('storage flush notifier', () => {
  afterEach(() => vi.useRealTimers());

  it('debounces writes and flushes once after the trailing delay', async () => {
    vi.useFakeTimers();
    const invoke = vi.fn().mockResolvedValue(undefined);
    const notifier = createStorageFlushNotifier({ invoke }, 500);

    notifier.markDirty();
    await vi.advanceTimersByTimeAsync(300);
    notifier.markDirty();
    await vi.advanceTimersByTimeAsync(499);
    expect(invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('desktop.storage.flush');
  });

  it('is a no-op without a desktop bridge', async () => {
    vi.useFakeTimers();
    const notifier = createStorageFlushNotifier(undefined, 500);
    expect(() => notifier.markDirty()).not.toThrow();
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forces a flush within the maximum wait while writes keep arriving', async () => {
    vi.useFakeTimers();
    const sentAt: number[] = [];
    const invoke = vi.fn(async () => {
      sentAt.push(Date.now());
    });
    const notifier = createStorageFlushNotifier({ invoke }, 500);
    const start = Date.now();

    // A write every 100 ms for 10 s: the trailing 500 ms debounce alone would never fire.
    for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
      notifier.markDirty();
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(sentAt.length).toBeGreaterThanOrEqual(4);
    let previous = start;
    for (const at of sentAt) {
      expect(at - previous).toBeLessThanOrEqual(2_000);
      previous = at;
    }
    notifier.dispose();
  });

  it('flushNow sends a pending flush at once and is a no-op when nothing is pending', async () => {
    vi.useFakeTimers();
    const invoke = vi.fn().mockResolvedValue(undefined);
    const notifier = createStorageFlushNotifier({ invoke }, 500);

    notifier.flushNow();
    expect(invoke).not.toHaveBeenCalled();

    notifier.markDirty();
    notifier.flushNow();
    expect(invoke).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(invoke).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispose sends a pending flush instead of dropping it, then stops', async () => {
    vi.useFakeTimers();
    const invoke = vi.fn().mockResolvedValue(undefined);
    const notifier = createStorageFlushNotifier({ invoke }, 500);

    notifier.markDirty();
    notifier.dispose();
    expect(invoke).toHaveBeenCalledOnce();

    notifier.markDirty();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(invoke).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushNow is safe without a desktop bridge', () => {
    const notifier = createStorageFlushNotifier(undefined, 500);
    expect(() => notifier.flushNow()).not.toThrow();
  });
});
