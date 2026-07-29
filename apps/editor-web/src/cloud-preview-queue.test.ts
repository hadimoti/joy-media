import { describe, expect, it } from 'vitest';
import { CloudPreviewQueue } from './cloud-preview-queue.js';

describe('CloudPreviewQueue', () => {
  it('limits concurrent originals and starts pending requests as slots open', async () => {
    const queue = new CloudPreviewQueue(2);
    const started: string[] = [];
    const gates = new Map<string, () => void>();
    const request = (id: string) =>
      queue.load(
        id,
        () =>
          new Promise<Blob>((resolve) => {
            started.push(id);
            gates.set(id, () => resolve(new Blob([id])));
          }),
      );

    const first = request('first');
    const second = request('second');
    const third = request('third');
    await Promise.resolve();
    expect(started).toEqual(['first', 'second']);

    gates.get('first')?.();
    await first;
    await Promise.resolve();
    expect(started).toEqual(['first', 'second', 'third']);

    gates.get('second')?.();
    gates.get('third')?.();
    await expect(second).resolves.toBeInstanceOf(Blob);
    await expect(third).resolves.toBeInstanceOf(Blob);
  });

  it('coalesces a repeated request for the same cloud asset', async () => {
    const queue = new CloudPreviewQueue();
    let calls = 0;
    const request = () => {
      calls += 1;
      return Promise.resolve(new Blob(['preview']));
    };

    const first = queue.load('asset-1', request);
    const second = queue.load('asset-1', request);
    expect(second).toBe(first);
    await expect(first).resolves.toBeInstanceOf(Blob);
    expect(calls).toBe(1);
  });
});
