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
});
