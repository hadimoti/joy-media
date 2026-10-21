import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeMediaAsync, setMediaProbeSpawnForTests } from './media-probe.js';

afterEach(() => setMediaProbeSpawnForTests(undefined));

describe('probeMediaAsync termination', () => {
  it('rejects after the kill grace period if the child never closes', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    setMediaProbeSpawnForTests(() => child as never);
    let resolved = false;
    const startedAt = performance.now();
    const probe = probeMediaAsync('hung-probe.mp4', { timeoutMs: 1 }).then((value) => {
      resolved = true;
      return value;
    });

    await expect(probe).rejects.toThrow('Media probe failed to terminate within 5000ms');

    expect(child.kill).toHaveBeenCalledOnce();
    expect(resolved).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(7_000);
  }, 8_000);
});
