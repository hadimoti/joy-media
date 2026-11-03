import { describe, expect, it, vi } from 'vitest';
import { registerShutdownHooks } from './shutdown.js';

function harness() {
  const appListeners = new Map<string, () => void>();
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
  registerShutdownHooks({
    onAppEvent: (event, listener) => appListeners.set(event, listener),
    onProcessSignal: (signal, listener) => signalListeners.set(signal, listener),
    stopWorker,
    discardUploads,
    flush,
    quit,
    platform: 'win32',
  });
  return { appListeners, signalListeners, stopWorker, discardUploads, flush, quit, order };
}

describe('registerShutdownHooks', () => {
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
