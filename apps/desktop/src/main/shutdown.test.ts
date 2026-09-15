import { describe, expect, it, vi } from 'vitest';
import { registerShutdownHooks } from './shutdown.js';

function harness() {
  const appListeners = new Map<string, () => void>();
  const signalListeners = new Map<string, () => void>();
  const order: string[] = [];
  const stopWorker = vi.fn(() => {
    order.push('stopWorker');
  });
  const flush = vi.fn(async () => {
    order.push('flush');
  });
  const quit = vi.fn();
  registerShutdownHooks({
    onAppEvent: (event, listener) => appListeners.set(event, listener),
    onProcessSignal: (signal, listener) => signalListeners.set(signal, listener),
    stopWorker,
    flush,
    quit,
    platform: 'win32',
  });
  return { appListeners, signalListeners, stopWorker, flush, quit, order };
}

describe('registerShutdownHooks', () => {
  it('stops the worker before flushing on before-quit', async () => {
    const { appListeners, order } = harness();
    appListeners.get('before-quit')?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['stopWorker', 'flush']);
  });

  it('quits on window-all-closed on Windows', async () => {
    const { appListeners, quit } = harness();
    appListeners.get('window-all-closed')?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('runs shutdown exactly once even if multiple signals arrive', async () => {
    const { signalListeners, flush } = harness();
    signalListeners.get('SIGINT')?.();
    signalListeners.get('SIGTERM')?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
