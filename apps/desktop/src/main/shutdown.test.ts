import { describe, expect, it, vi } from 'vitest';
import { registerShutdownHooks } from './shutdown.js';

function harness() {
  const appListeners = new Map<string, (event?: { preventDefault(): void }) => void>();
  const signalListeners = new Map<string, () => void>();
  const order: string[] = [];
  const stopWorker = vi.fn(() => {
    order.push('stopWorker');
  });
  const discardUploads = vi.fn(async () => {
    order.push('discardUploads');
  });
  const flush = vi.fn(async () => {
    order.push('flush');
  });
  const quit = vi.fn();
  const shutdown = registerShutdownHooks({
    onAppEvent: (event, listener) => appListeners.set(event, listener),
    onProcessSignal: (signal, listener) => signalListeners.set(signal, listener),
    stopWorker,
    discardUploads,
    flush,
    quit,
    platform: 'win32',
  });
  return {
    appListeners,
    signalListeners,
    stopWorker,
    discardUploads,
    flush,
    quit,
    order,
    shutdown,
  };
}

describe('registerShutdownHooks', () => {
  it('allows quit after a shutdown step becomes stuck', async () => {
    vi.useFakeTimers();
    try {
      let beforeQuit: ((event?: { preventDefault(): void }) => void) | undefined;
      let finishStop: (() => void) | undefined;
      const quit = vi.fn();
      const onError = vi.fn();
      const discardUploads = vi.fn();
      const flush = vi.fn();
      registerShutdownHooks({
        onAppEvent: (event, listener) => {
          if (event === 'before-quit') beforeQuit = listener;
        },
        onProcessSignal: () => undefined,
        stopWorker: () =>
          new Promise<void>((resolve) => {
            finishStop = resolve;
          }),
        discardUploads,
        flush,
        quit,
        onError,
      });
      beforeQuit?.({ preventDefault: () => undefined });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(quit).toHaveBeenCalledTimes(1);
      finishStop?.();
      await Promise.resolve();
      expect(discardUploads).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds an explicit quit until shutdown completes', async () => {
    let finishStop: (() => void) | undefined;
    let beforeQuit: ((event?: { preventDefault(): void }) => void) | undefined;
    const quit = vi.fn();
    registerShutdownHooks({
      onAppEvent: (event, listener) => {
        if (event === 'before-quit') beforeQuit = listener;
      },
      onProcessSignal: () => undefined,
      stopWorker: () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
      discardUploads: () => undefined,
      flush: () => undefined,
      quit,
    });
    const preventDefault = vi.fn();
    beforeQuit?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    finishStop?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(quit).toHaveBeenCalledTimes(1);
    const nextQuit = vi.fn();
    beforeQuit?.({ preventDefault: nextQuit });
    expect(nextQuit).not.toHaveBeenCalled();
  });

  it('continues cleanup and quits if stopping the worker fails', async () => {
    let closeWindow: (() => void) | undefined;
    const order: string[] = [];
    registerShutdownHooks({
      onAppEvent: (event, listener) => {
        if (event === 'window-all-closed') closeWindow = listener;
      },
      onProcessSignal: () => undefined,
      stopWorker: () => {
        throw new Error('worker stop failed');
      },
      discardUploads: () => {
        order.push('uploads');
      },
      flush: () => {
        order.push('database');
      },
      quit: () => {
        order.push('quit');
      },
      platform: 'win32',
    });
    closeWindow?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['uploads', 'database', 'quit']);
  });

  it('waits for the worker to stop before cleaning uploads or closing the database', async () => {
    let finishStop: (() => void) | undefined;
    const order: string[] = [];
    const shutdown = registerShutdownHooks({
      onAppEvent: () => undefined,
      onProcessSignal: () => undefined,
      stopWorker: () => {
        order.push('stopWorker');
        return new Promise<void>((resolve) => {
          finishStop = resolve;
        });
      },
      discardUploads: () => {
        order.push('discardUploads');
      },
      flush: () => {
        order.push('flush');
      },
      quit: () => undefined,
    });
    const stopping = shutdown();
    expect(order).toEqual(['stopWorker']);
    finishStop?.();
    await stopping;
    expect(order).toEqual(['stopWorker', 'discardUploads', 'flush']);
  });

  it('exposes the same shutdown operation for an explicit restart', async () => {
    const { shutdown, order } = harness();
    await shutdown();
    expect(order).toEqual(['stopWorker', 'discardUploads', 'flush']);
  });

  it('stops the worker, drops unfinished uploads, then flushes on before-quit', async () => {
    const { appListeners, order } = harness();
    appListeners.get('before-quit')?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['stopWorker', 'discardUploads', 'flush']);
  });

  it('quits on window-all-closed on Windows', async () => {
    const { appListeners, quit } = harness();
    appListeners.get('window-all-closed')?.();
    // Shutdown now waits for the upload cleanup as well, so let every queued step run first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('runs shutdown exactly once even if multiple signals arrive', async () => {
    const { signalListeners, flush, discardUploads } = harness();
    signalListeners.get('SIGINT')?.();
    signalListeners.get('SIGTERM')?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(discardUploads).toHaveBeenCalledTimes(1);
  });
});
