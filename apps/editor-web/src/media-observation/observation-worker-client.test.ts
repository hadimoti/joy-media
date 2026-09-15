import { describe, expect, it } from 'vitest';
import { ObservationWorkerClient } from './observation-worker-client.js';
import type {
  ObservationWorkerRequest,
  ObservationWorkerResponse,
} from './observation-protocol.js';

class FakeObservationWorker {
  readonly messages: ObservationWorkerRequest[] = [];
  #messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
  #errorListeners = new Set<(event: ErrorEvent) => void>();
  terminated = false;

  addEventListener(type: 'message' | 'error', listener: never): void {
    if (type === 'message')
      this.#messageListeners.add(listener as (event: MessageEvent<unknown>) => void);
    else this.#errorListeners.add(listener as (event: ErrorEvent) => void);
  }

  removeEventListener(type: 'message' | 'error', listener: never): void {
    if (type === 'message')
      this.#messageListeners.delete(listener as (event: MessageEvent<unknown>) => void);
    else this.#errorListeners.delete(listener as (event: ErrorEvent) => void);
  }

  postMessage(message: ObservationWorkerRequest): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(response: ObservationWorkerResponse): void {
    for (const listener of this.#messageListeners)
      listener({ data: response } as MessageEvent<unknown>);
  }
}

const assetDigest = 'a'.repeat(64);

function frameResponse(jobId: string): ObservationWorkerResponse {
  const blob = new Blob(['thumbnail'], { type: 'image/jpeg' });
  return {
    type: 'frame',
    jobId,
    sequence: 0,
    frame: {
      id: `source-frame:v1:${assetDigest}:video-0:0:0:timebase-1-1000000`,
      identity: {
        assetDigest,
        streamId: 'video-0',
        presentationIndex: 0,
        ptsTicks: '0',
        timebaseNumerator: 1,
        timebaseDenominator: 1_000_000,
        sourceTimeUs: 0,
        durationUs: 33_333,
      },
      actualTimeUs: 0,
      durationUs: 33_333,
      presentationIndex: 0,
      width: 160,
      height: 90,
      thumbnail: {
        blob,
        width: 160,
        height: 90,
        byteLength: blob.size,
        mimeType: 'image/jpeg',
      },
    },
  };
}

describe('observation worker client', () => {
  it('acknowledges only when a consumer advances past a delivered frame', async () => {
    const worker = new FakeObservationWorker();
    const client = new ObservationWorkerClient({ createWorker: () => worker });
    const iterable = client.frames(
      {
        assetDigest,
        streamId: 'video-0',
        source: new Blob(['fixture'], { type: 'video/mp4' }),
        epoch: 1,
        range: { startUs: 0, endUs: 100_000 },
      },
      new AbortController().signal,
    );
    const iterator = iterable[Symbol.asyncIterator]();
    const decode = worker.messages[0];
    expect(decode).toMatchObject({ type: 'decode-range' });
    if (decode?.type !== 'decode-range') throw new Error('missing decode request');

    const first = iterator.next();
    worker.emit(frameResponse(decode.jobId));
    const delivered = await first;
    expect(delivered.done).toBe(false);
    expect(worker.messages.filter((message) => message.type === 'ack-frame')).toEqual([]);

    const afterFrame = iterator.next();
    expect(worker.messages.at(-1)).toEqual({ type: 'ack-frame', jobId: decode.jobId, sequence: 0 });
    worker.emit({ type: 'complete', jobId: decode.jobId, decodedFrameCount: 1 });
    await expect(afterFrame).resolves.toEqual({ value: undefined, done: true });
    await client.close();
    expect(worker.terminated).toBe(true);
  });

  it('cancels the worker job and stops delivery when the caller aborts', async () => {
    const worker = new FakeObservationWorker();
    const client = new ObservationWorkerClient({ createWorker: () => worker });
    const controller = new AbortController();
    const iterable = client.frames(
      {
        assetDigest,
        streamId: 'video-0',
        source: new Blob(['fixture'], { type: 'video/mp4' }),
        epoch: 1,
        range: { startUs: 0, endUs: 100_000 },
      },
      controller.signal,
    );
    const iterator = iterable[Symbol.asyncIterator]();
    const decode = worker.messages[0];
    if (decode?.type !== 'decode-range') throw new Error('missing decode request');
    const next = iterator.next();
    controller.abort();
    await expect(next).rejects.toMatchObject({ code: 'cancelled' });
    expect(worker.messages.at(-1)).toEqual({ type: 'cancel', jobId: decode.jobId });
    worker.emit({ type: 'cancelled', jobId: decode.jobId });
    await client.close();
  });

  it('forwards an explicit Monitor playback-priority signal without starting a decode', async () => {
    const worker = new FakeObservationWorker();
    const client = new ObservationWorkerClient({ createWorker: () => worker });
    client.setPlaybackPriorityActive(true);
    expect(worker.messages).toEqual([{ type: 'set-playback-priority', active: true }]);
    await client.close();
  });
});
