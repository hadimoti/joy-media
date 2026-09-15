import {
  assertObservationWorkerRequest,
  createObservationWorkerJobId,
  DEFAULT_OBSERVATION_THUMBNAIL_BOUNDS,
  isObservationWorkerResponse,
  type ObservationThumbnailBounds,
  type ObservationWorkerDecodeRequest,
  type ObservationWorkerDecodedFrame,
  type ObservationWorkerFailureCode,
  type ObservationWorkerRequest,
  type ObservationWorkerResponse,
} from './observation-protocol.js';
import type { SourceObservationRange } from './source-decoder.js';

interface ObservationWorkerLike {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  postMessage(message: ObservationWorkerRequest): void;
  terminate(): void;
}

export interface ObservationWorkerClientOptions {
  readonly createWorker?: () => ObservationWorkerLike;
}

export interface DecodeSourceObservationRequest {
  readonly assetDigest: string;
  readonly streamId: string;
  /** A trusted host Blob; no source URL/path crosses this API. */
  readonly source: Blob;
  readonly epoch: number;
  readonly range: SourceObservationRange;
  readonly thumbnail?: Partial<ObservationThumbnailBounds>;
}

export class ObservationWorkerClientError extends Error {
  constructor(readonly code: ObservationWorkerFailureCode | 'closed') {
    super(`JOY observation worker failed: ${code}`);
    this.name = 'ObservationWorkerClientError';
  }
}

/**
 * Browser-side client for the dedicated decoder Worker. The returned async
 * iterator sends an acknowledgement only when the caller advances, so there
 * is at most one unconsumed decoded artifact per job.
 */
export class ObservationWorkerClient {
  readonly #worker: ObservationWorkerLike;
  readonly #jobs = new Map<string, ObservationWorkerFrameStream>();
  #nextJobSequence = 0;
  #closed = false;

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    if (!isObservationWorkerResponse(event.data)) return;
    this.#receive(event.data);
  };

  readonly #onError = (): void => {
    for (const job of this.#jobs.values()) job.fail('worker-failed');
    this.#jobs.clear();
  };

  constructor(options: ObservationWorkerClientOptions = {}) {
    this.#worker =
      options.createWorker?.() ??
      (new Worker(new URL('./observation.worker.ts', import.meta.url), {
        type: 'module',
        name: 'joy-observation',
      }) as unknown as ObservationWorkerLike);
    this.#worker.addEventListener('message', this.#onMessage);
    this.#worker.addEventListener('error', this.#onError);
  }

  frames(
    request: DecodeSourceObservationRequest,
    signal: AbortSignal,
  ): AsyncIterable<ObservationWorkerDecodedFrame> {
    if (this.#closed) throw new ObservationWorkerClientError('closed');
    if (signal.aborted) throw new ObservationWorkerClientError('cancelled');
    if (this.#nextJobSequence >= Number.MAX_SAFE_INTEGER) this.#nextJobSequence = 0;
    this.#nextJobSequence += 1;
    const workerRequest: ObservationWorkerDecodeRequest = {
      type: 'decode-range',
      jobId: createObservationWorkerJobId(this.#nextJobSequence),
      assetDigest: request.assetDigest,
      streamId: request.streamId,
      source: request.source,
      epoch: request.epoch,
      range: request.range,
      thumbnail: normalizeThumbnailBounds(request.thumbnail),
    };
    assertObservationWorkerRequest(workerRequest);

    const stream = new ObservationWorkerFrameStream(workerRequest.jobId, this.#worker, signal);
    this.#jobs.set(workerRequest.jobId, stream);
    this.#worker.postMessage(workerRequest);
    return stream;
  }

  /** Pause opening background decode samples while the real Monitor plays. */
  setPlaybackPriorityActive(active: boolean): void {
    if (this.#closed) return;
    this.#worker.postMessage({ type: 'set-playback-priority', active });
  }

  /**
   * Ask all jobs to cleanly close their decoder samples, wait briefly for the
   * worker's terminal events, then terminate the dedicated runtime.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const pending = [...this.#jobs.values()];
    for (const job of pending) job.cancel();
    await Promise.race([
      Promise.all(pending.map((job) => job.finished)),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
    for (const job of this.#jobs.values()) job.fail('closed');
    this.#jobs.clear();
    this.#worker.removeEventListener('message', this.#onMessage);
    this.#worker.removeEventListener('error', this.#onError);
    this.#worker.terminate();
  }

  #receive(response: ObservationWorkerResponse): void {
    const job = this.#jobs.get(response.jobId);
    if (job === undefined) return;
    switch (response.type) {
      case 'frame':
        job.push(response.sequence, response.frame);
        return;
      case 'complete':
        job.complete();
        this.#jobs.delete(response.jobId);
        return;
      case 'cancelled':
        job.fail('cancelled');
        this.#jobs.delete(response.jobId);
        return;
      case 'failed':
        job.fail(response.code);
        this.#jobs.delete(response.jobId);
    }
  }
}

class ObservationWorkerFrameStream implements AsyncIterable<ObservationWorkerDecodedFrame> {
  readonly #queue: Array<{
    readonly sequence: number;
    readonly frame: ObservationWorkerDecodedFrame;
  }> = [];
  #deliveredSequence: number | undefined;
  #waiting:
    | {
        readonly resolve: (result: IteratorResult<ObservationWorkerDecodedFrame>) => void;
        readonly reject: (error: Error) => void;
      }
    | undefined;
  #terminal: 'complete' | ObservationWorkerFailureCode | 'closed' | undefined;
  #deliveryClosed = false;
  #resolveFinished!: () => void;
  readonly finished: Promise<void>;

  constructor(
    readonly jobId: string,
    private readonly worker: ObservationWorkerLike,
    signal: AbortSignal,
  ) {
    this.finished = new Promise<void>((resolve) => {
      this.#resolveFinished = resolve;
    });
    signal.addEventListener(
      'abort',
      () => {
        this.cancel();
        this.fail('cancelled');
      },
      { once: true },
    );
  }

  [Symbol.asyncIterator](): AsyncIterator<ObservationWorkerDecodedFrame> {
    return this;
  }

  async next(): Promise<IteratorResult<ObservationWorkerDecodedFrame>> {
    if (this.#deliveredSequence !== undefined) {
      this.worker.postMessage({
        type: 'ack-frame',
        jobId: this.jobId,
        sequence: this.#deliveredSequence,
      });
      this.#deliveredSequence = undefined;
    }
    if (this.#deliveryClosed || this.#terminal === 'complete')
      return { value: undefined, done: true };
    if (this.#terminal !== undefined) throw new ObservationWorkerClientError(this.#terminal);
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      this.#deliveredSequence = queued.sequence;
      return { value: queued.frame, done: false };
    }
    return new Promise<IteratorResult<ObservationWorkerDecodedFrame>>((resolve, reject) => {
      this.#waiting = { resolve, reject };
    });
  }

  async return(): Promise<IteratorResult<ObservationWorkerDecodedFrame>> {
    this.#deliveryClosed = true;
    this.cancel();
    this.#settleWaitingDone();
    return { value: undefined, done: true };
  }

  push(sequence: number, frame: ObservationWorkerDecodedFrame): void {
    if (this.#deliveryClosed || this.#terminal !== undefined) {
      this.cancel();
      return;
    }
    if (this.#queue.length > 0 || this.#deliveredSequence !== undefined) {
      this.fail('worker-failed');
      this.cancel();
      return;
    }
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      this.#waiting = undefined;
      this.#deliveredSequence = sequence;
      waiting.resolve({ value: frame, done: false });
      return;
    }
    this.#queue.push({ sequence, frame });
  }

  complete(): void {
    if (this.#terminal !== undefined) return;
    this.#terminal = 'complete';
    this.#resolveFinished();
    this.#settleWaitingDone();
  }

  fail(code: ObservationWorkerFailureCode | 'closed'): void {
    if (this.#terminal !== undefined) return;
    this.#terminal = code;
    this.#resolveFinished();
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.reject(new ObservationWorkerClientError(code));
  }

  cancel(): void {
    if (this.#terminal === 'complete') return;
    this.worker.postMessage({ type: 'cancel', jobId: this.jobId });
  }

  #settleWaitingDone(): void {
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.resolve({ value: undefined, done: true });
  }
}

function normalizeThumbnailBounds(
  partial: DecodeSourceObservationRequest['thumbnail'],
): ObservationThumbnailBounds {
  return {
    ...DEFAULT_OBSERVATION_THUMBNAIL_BOUNDS,
    ...partial,
  };
}
