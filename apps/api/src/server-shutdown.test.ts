import { describe, expect, it, vi } from 'vitest';
import { installApiShutdownHandlers, type ApiShutdownSignal } from './server-shutdown.js';

function fakeProcess() {
  const listeners = new Map<ApiShutdownSignal, () => void>();
  return {
    listeners,
    on: vi.fn((signal: ApiShutdownSignal, listener: () => void) => {
      listeners.set(signal, listener);
    }),
    removeListener: vi.fn((signal: ApiShutdownSignal) => {
      listeners.delete(signal);
    }),
    exit: vi.fn(),
    signal(signal: ApiShutdownSignal) {
      listeners.get(signal)?.();
    },
  };
}

describe('installApiShutdownHandlers', () => {
  it('closes the server before exiting cleanly', () => {
    const processLike = fakeProcess();
    let closeCallback: ((error?: Error) => void) | undefined;
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => {
        closeCallback = callback;
      }),
    };
    installApiShutdownHandlers(server as never, processLike, 100);

    processLike.signal('SIGTERM');
    expect(server.close).toHaveBeenCalledOnce();
    expect(processLike.exit).not.toHaveBeenCalled();
    closeCallback?.();
    expect(processLike.exit).toHaveBeenCalledWith(0);
  });

  it('exits unsuccessfully when close fails or the shutdown deadline expires', async () => {
    const failedProcess = fakeProcess();
    const failedServer = {
      close: vi.fn((callback: (error?: Error) => void) => callback(new Error())),
    };
    installApiShutdownHandlers(failedServer as never, failedProcess, 100);
    failedProcess.signal('SIGINT');
    expect(failedProcess.exit).toHaveBeenCalledWith(1);

    const timedOutProcess = fakeProcess();
    const hungServer = { close: vi.fn() };
    installApiShutdownHandlers(hungServer as never, timedOutProcess, 10);
    timedOutProcess.signal('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(timedOutProcess.exit).toHaveBeenCalledWith(1);
  });

  it('forces exit when a second signal arrives during shutdown', () => {
    const processLike = fakeProcess();
    const server = { close: vi.fn() };
    installApiShutdownHandlers(server as never, processLike, 100);

    processLike.signal('SIGTERM');
    processLike.signal('SIGINT');

    expect(server.close).toHaveBeenCalledOnce();
    expect(processLike.exit).toHaveBeenCalledWith(1);
  });
});
