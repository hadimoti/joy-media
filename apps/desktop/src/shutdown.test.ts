import { describe, expect, it, vi } from 'vitest';
import { disposeWorkerForQuit } from './shutdown.js';

describe('desktop quit shutdown', () => {
  it('awaits WorkerController disposal before returning', async () => {
    let finished = false;
    const dispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            finished = true;
            resolve();
          }, 5);
        }),
    );
    const pending = disposeWorkerForQuit({ dispose });
    expect(finished).toBe(false);
    await pending;
    expect(finished).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
