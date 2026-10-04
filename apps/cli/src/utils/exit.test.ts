import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { exitWithCode } from './exit.js';

describe('exitWithCode', () => {
  it('sets the exit status before flushing stdout and stderr and then exits', async () => {
    const callbacks: Array<() => void> = [];
    const stream = () =>
      new Writable({
        write(_chunk, _encoding, callback) {
          callbacks.push(callback);
        },
      });
    const stdout = stream();
    const stderr = stream();
    const exit = vi.fn((code: number) => {
      expect(code).toBe(7);
      return undefined as never;
    });
    const previousExitCode = process.exitCode;
    const pending = exitWithCode(7, { stdout, stderr, exit });
    expect(process.exitCode).toBe(7);
    expect(exit).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(2);
    callbacks.forEach((callback) => callback());
    await pending;
    expect(exit).toHaveBeenCalledOnce();
    process.exitCode = previousExitCode;
    stdout.destroy();
    stderr.destroy();
  });
});
