import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { answerHashRequest, sha256OfBlob } from './blob-sha256.js';

/** Deterministic bytes that are not all the same, so a wrong byte order shows up. */
function sampleBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + (i >>> 8) * 7) & 0xff;
  return bytes;
}

function nodeSha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('sha256OfBlob', () => {
  it.each([0, 1, 55, 56, 63, 64, 65, 127, 128, 1000, 4099])(
    'matches node:crypto for %i bytes read in 7-byte slices',
    async (length) => {
      const bytes = sampleBytes(length);
      const digest = await sha256OfBlob(new Blob([bytes]), { sliceBytes: 7 });
      expect(digest).toBe(nodeSha256Hex(bytes));
    },
  );

  it('gives the same digest whatever the slice size', async () => {
    const bytes = sampleBytes(10_000);
    const expected = nodeSha256Hex(bytes);
    for (const sliceBytes of [1, 63, 64, 65, 8 * 1024 * 1024]) {
      expect(await sha256OfBlob(new Blob([bytes]), { sliceBytes })).toBe(expected);
    }
  });

  it('hashes a Blob made of several parts as one file', async () => {
    const first = sampleBytes(300);
    const second = sampleBytes(77);
    const whole = new Uint8Array(new ArrayBuffer(first.length + second.length));
    whole.set(first, 0);
    whole.set(second, first.length);
    const digest = await sha256OfBlob(new Blob([first, second]), { sliceBytes: 100 });
    expect(digest).toBe(nodeSha256Hex(whole));
  });

  it('rejects a slice size that is not a positive whole number', async () => {
    const blob = new Blob([sampleBytes(4)]);
    await expect(sha256OfBlob(blob, { sliceBytes: 0 })).rejects.toThrow(RangeError);
    await expect(sha256OfBlob(blob, { sliceBytes: 1.5 })).rejects.toThrow(RangeError);
  });

  it('stops between slices when the signal is aborted mid-way', async () => {
    const controller = new AbortController();
    const blob = new Blob([sampleBytes(100)]);
    let slices = 0;
    const source = {
      size: blob.size,
      slice: (start: number, end: number) => {
        slices += 1;
        if (slices === 2) controller.abort();
        return blob.slice(start, end);
      },
    } as unknown as Blob;

    await expect(
      sha256OfBlob(source, { sliceBytes: 10, signal: controller.signal }),
    ).rejects.toThrow();
    expect(slices).toBe(2);
  });

  it('stops without a digest when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      sha256OfBlob(new Blob([sampleBytes(10)]), { signal: controller.signal }),
    ).rejects.toThrow();
  });
});

/**
 * Stands in for the hashing worker. It answers each request one message later with a digest computed by node:crypto,
 * or stays silent, or reports a worker error, so the tests can drive every path of sha256OfBlob.
 */
class FakeHashWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: Array<{ blob: Blob; sliceBytes?: number }> = [];
  terminated = false;
  private readonly mode: 'answer' | 'silent' | 'fail' | 'malformed' | 'throw-on-post';
  private readonly failure: string;

  constructor(
    mode: 'answer' | 'silent' | 'fail' | 'malformed' | 'throw-on-post' = 'answer',
    failure = 'worker crashed',
  ) {
    this.mode = mode;
    this.failure = failure;
  }

  postMessage(request: { blob: Blob; sliceBytes?: number }): void {
    this.requests.push(request);
    if (this.mode === 'throw-on-post') throw new Error('cannot post to the worker');
    if (this.mode === 'silent') return;
    queueMicrotask(() => {
      if (this.terminated) return;
      if (this.mode === 'fail') {
        this.onerror?.({ message: this.failure } as ErrorEvent);
        return;
      }
      if (this.mode === 'malformed') {
        this.onmessage?.({ data: 'not a reply' } as MessageEvent<unknown>);
        return;
      }
      void request.blob.arrayBuffer().then((buffer) => {
        if (this.terminated) return;
        const digest = createHash('sha256').update(Buffer.from(buffer)).digest('hex');
        this.onmessage?.({ data: { digest } } as MessageEvent<unknown>);
      });
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

function fakeWorkerFactory(worker: FakeHashWorker): () => Worker {
  return () => worker as unknown as Worker;
}

describe('sha256OfBlob hashes in a worker, off the calling thread', () => {
  it('posts the Blob to the worker and resolves with the digest the worker returns', async () => {
    const bytes = sampleBytes(5000);
    const worker = new FakeHashWorker();
    await expect(
      sha256OfBlob(new Blob([bytes]), { createWorker: fakeWorkerFactory(worker), sliceBytes: 7 }),
    ).resolves.toBe(nodeSha256Hex(bytes));
    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0]?.blob.size).toBe(bytes.length);
    expect(worker.requests[0]?.sliceBytes).toBe(7);
    expect(worker.terminated).toBe(true);
  });

  it('terminates the worker and rejects when the caller aborts mid-hash', async () => {
    const controller = new AbortController();
    const worker = new FakeHashWorker('silent');
    const pending = sha256OfBlob(new Blob([sampleBytes(100)]), {
      signal: controller.signal,
      createWorker: fakeWorkerFactory(worker),
    });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(worker.terminated).toBe(true);
  });

  it('rejects with the worker error and never returns a digest', async () => {
    const worker = new FakeHashWorker('fail', 'worker crashed');
    await expect(
      sha256OfBlob(new Blob([sampleBytes(10)]), { createWorker: fakeWorkerFactory(worker) }),
    ).rejects.toThrow('worker crashed');
    expect(worker.terminated).toBe(true);
  });

  it('refuses a bad slice size before it starts a worker', async () => {
    let created = 0;
    await expect(
      sha256OfBlob(new Blob([sampleBytes(4)]), {
        sliceBytes: 0,
        createWorker: () => {
          created += 1;
          return new FakeHashWorker() as unknown as Worker;
        },
      }),
    ).rejects.toThrow(RangeError);
    expect(created).toBe(0);
  });

  it('rejects instead of hanging when the worker sends a reply that is not a reply', async () => {
    const worker = new FakeHashWorker('malformed');
    await expect(
      sha256OfBlob(new Blob([sampleBytes(10)]), { createWorker: fakeWorkerFactory(worker) }),
    ).rejects.toThrow('unexpected reply');
    expect(worker.terminated).toBe(true);
  });

  it('terminates the worker and rejects when posting the Blob throws', async () => {
    const worker = new FakeHashWorker('throw-on-post');
    await expect(
      sha256OfBlob(new Blob([sampleBytes(10)]), { createWorker: fakeWorkerFactory(worker) }),
    ).rejects.toThrow('cannot post to the worker');
    expect(worker.terminated).toBe(true);
  });
});

describe('answerHashRequest, the worker script logic', () => {
  it('replies with the digest of the Blob it was given', async () => {
    const bytes = sampleBytes(3000);
    await expect(answerHashRequest({ blob: new Blob([bytes]), sliceBytes: 9 })).resolves.toEqual({
      digest: nodeSha256Hex(bytes),
    });
  });

  it('replies with the error text instead of throwing when the request is invalid', async () => {
    await expect(
      answerHashRequest({ blob: new Blob([sampleBytes(4)]), sliceBytes: 0 }),
    ).resolves.toEqual({ error: 'sliceBytes must be a positive safe integer' });
  });
});
