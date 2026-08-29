import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAssetTimelineTimeout } from './AssetLibraryPanel.js';

describe('withAssetTimelineTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves successful synchronous and asynchronous operations', async () => {
    await expect(withAssetTimelineTimeout('ready', 'operation')).resolves.toBe('ready');
    await expect(withAssetTimelineTimeout(Promise.resolve('done'), 'operation')).resolves.toBe(
      'done',
    );
  });

  it('rejects a stalled operation with an actionable timeout', async () => {
    vi.useFakeTimers();
    const pending = withAssetTimelineTimeout(new Promise(() => undefined), 'Adding asset', 1_000);
    const assertion = expect(pending).rejects.toThrow('Adding asset timed out after 1 seconds');
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});
