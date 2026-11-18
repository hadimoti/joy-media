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

  it('flushNow flushes even when no renderer notice has arrived yet', () => {
    // Writes still inside the renderer's debounce window never reach the main process as dirty,
    // so a final flush at quit or window close must not depend on the dirty flag.
    const flushStorageData = vi.fn();
    const controller = createStorageFlushController(flushStorageData);

    controller.flushNow();

    expect(flushStorageData).toHaveBeenCalledOnce();
    expect(controller.isDirty()).toBe(false);
  });

  it('reports a failed flush to onError and stays dirty for the retry', () => {
    const failure = new Error('temporary failure');
    const onError = vi.fn();
    const flushStorageData = vi.fn().mockImplementationOnce(() => {
      throw failure;
    });
    const controller = createStorageFlushController(flushStorageData, onError);

    controller.flushNow();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(controller.isDirty()).toBe(true);
  });
});
