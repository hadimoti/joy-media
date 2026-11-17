import { describe, expect, it, vi } from 'vitest';
import { createStorageFlushController } from './storage-flush.js';

describe('storage flush controller', () => {
  it('calls Electron DOM storage flush for a renderer flush request', () => {
    const flushStorageData = vi.fn();
    const controller = createStorageFlushController(flushStorageData);

    controller.markDirty();

    expect(flushStorageData).toHaveBeenCalledOnce();
    expect(controller.isDirty()).toBe(false);
  });

  it('retries a failed flush only while dirty', () => {
    const flushStorageData = vi.fn().mockImplementationOnce(() => {
      throw new Error('temporary failure');
    });
    const controller = createStorageFlushController(flushStorageData);

    controller.markDirty();
    expect(controller.isDirty()).toBe(true);
    controller.flushIfDirty();
    controller.flushIfDirty();

    expect(flushStorageData).toHaveBeenCalledTimes(2);
    expect(controller.isDirty()).toBe(false);
  });
});
