import {
  ObservationThumbnailError,
  type SourceObservationFrame,
} from './browser-sample-decoder.js';
import {
  assertObservationWorkerRequest,
  type ObservationWorkerDecodeRequest,
  type ObservationWorkerDecodedFrame,
  type ObservationWorkerFailureCode,
  type ObservationWorkerRequest,
  type ObservationWorkerResponse,
} from './observation-protocol.js';
import { ObservationResourceScheduler } from './resource-scheduler.js';
import {
  createBrowserSourceObservationDecoder,
  SourceObservationDecodeError,
  type SourceObservationDecoder,
} from './source-decoder.js';

interface ObservationWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: ObservationWorkerResponse): void;
}

interface WorkerJob {
  readonly request: ObservationWorkerDecodeRequest;
  readonly controller: AbortController;
  awaitingAck: AwaitingAck | undefined;
}

interface AwaitingAck {
  readonly sequence: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly clear: () => void;
}

const DEFAULT_WORKING_SET_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT = 2;
const ACK_TIMEOUT_MS = 10_000;

/**
 * Dedicated decode runtime. It serializes each artifact through an explicit
 * frame acknowledgement: a slow consumer cannot make the worker retain an
 * unbounded queue of VideoFrames, canvases, or Blobs.
 */
export class ObservationWorkerRuntime {
  readonly #jobs = new Map<string, WorkerJob>();
  readonly #scheduler = new ObservationResourceScheduler({
    maxWorkingSetBytes: DEFAULT_WORKING_SET_BYTES,
    maxInFlight: DEFAULT_MAX_IN_FLIGHT,
  });

  constructor(private readonly scope: ObservationWorkerScope) {}

  listen(): void {
    this.scope.addEventListener('message', (event) => {
      void this.handle(event.data);
    });
  }

  async handle(raw: unknown): Promise<void> {
    try {
      assertObservationWorkerRequest(raw);
    } catch {
      const jobId = extractSafeJobId(raw);
      if (jobId !== undefined)
        this.scope.postMessage({ type: 'failed', jobId, code: 'invalid-request' });
      return;
    }

    const request: ObservationWorkerRequest = raw;
    switch (request.type) {
      case 'decode-range':
        this.#start(request);
        return;
      case 'ack-frame':
        this.#acknowledge(request.jobId, request.sequence);
        return;
      case 'cancel':
        this.#jobs.get(request.jobId)?.controller.abort();
        return;
      case 'set-playback-priority':
        this.#scheduler.setPlaybackPriorityActive(request.active);
        return;
    }
  }

  #start(request: ObservationWorkerDecodeRequest): void {
    if (this.#jobs.has(request.jobId)) {
      this.scope.postMessage({ type: 'failed', jobId: request.jobId, code: 'invalid-request' });
      return;
    }
    const job: WorkerJob = { request, controller: new AbortController(), awaitingAck: undefined };
    this.#jobs.set(request.jobId, job);
    void this.#run(job);
  }

  async #run(job: WorkerJob): Promise<void> {
    let decoder: SourceObservationDecoder | undefined;
    let decodedFrameCount = 0;
    try {
      decoder = createBrowserSourceObservationDecoder({
        assetDigest: job.request.assetDigest,
        streamId: job.request.streamId,
        source: job.request.source,
        scheduler: this.#scheduler,
        epoch: job.request.epoch,
      });
      for await (const frame of decoder.frames(job.request.range, job.controller.signal)) {
        const thumbnail = await frame.createThumbnail(job.request.thumbnail);
        if (job.controller.signal.aborted) throw new ObservationWorkerCancelledError();
        const sequence = decodedFrameCount;
        this.scope.postMessage({
          type: 'frame',
          jobId: job.request.jobId,
          sequence,
          frame: serializeFrame(frame, thumbnail),
        });
        await this.#waitForAcknowledgement(job, sequence);
        decodedFrameCount += 1;
      }
      if (job.controller.signal.aborted) throw new ObservationWorkerCancelledError();
      this.scope.postMessage({
        type: 'complete',
        jobId: job.request.jobId,
        decodedFrameCount,
      });
    } catch (error) {
      if (error instanceof ObservationWorkerConsumerTimeoutError) {
        this.scope.postMessage({
          type: 'failed',
          jobId: job.request.jobId,
          code: 'consumer-timeout',
        });
      } else if (
        job.controller.signal.aborted ||
        error instanceof ObservationWorkerCancelledError
      ) {
        this.scope.postMessage({ type: 'cancelled', jobId: job.request.jobId });
      } else {
        this.scope.postMessage({
          type: 'failed',
          jobId: job.request.jobId,
          code: failureCode(error),
        });
      }
    } finally {
      this.#clearAwaitingAck(job);
      decoder?.close();
      this.#jobs.delete(job.request.jobId);
    }
  }

  #acknowledge(jobId: string, sequence: number): void {
    const job = this.#jobs.get(jobId);
    const awaiting = job?.awaitingAck;
    if (awaiting === undefined || awaiting.sequence !== sequence) return;
    job!.awaitingAck = undefined;
    awaiting.clear();
    awaiting.resolve();
  }

  #waitForAcknowledgement(job: WorkerJob, sequence: number): Promise<void> {
    if (job.awaitingAck !== undefined)
      return Promise.reject(new Error('observation worker attempted to queue multiple frames'));
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.#clearAwaitingAck(job);
        reject(new ObservationWorkerCancelledError());
      };
      const timer = setTimeout(() => {
        reject(new ObservationWorkerConsumerTimeoutError());
        job.controller.abort();
      }, ACK_TIMEOUT_MS);
      const clear = () => {
        clearTimeout(timer);
        job.controller.signal.removeEventListener('abort', onAbort);
      };
      job.controller.signal.addEventListener('abort', onAbort, { once: true });
      job.awaitingAck = { sequence, resolve, reject, clear };
    });
  }

  #clearAwaitingAck(job: WorkerJob): void {
    const awaiting = job.awaitingAck;
    if (awaiting === undefined) return;
    job.awaitingAck = undefined;
    awaiting.clear();
  }
}

function serializeFrame(
  frame: SourceObservationFrame,
  thumbnail: Awaited<ReturnType<SourceObservationFrame['createThumbnail']>>,
): ObservationWorkerDecodedFrame {
  return {
    id: frame.id,
    identity: frame.identity,
    actualTimeUs: frame.actualTimeUs,
    durationUs: frame.durationUs,
    presentationIndex: frame.presentationIndex,
    width: frame.width,
    height: frame.height,
    thumbnail: {
      blob: thumbnail.blob,
      width: thumbnail.width,
      height: thumbnail.height,
      byteLength: thumbnail.blob.size,
      mimeType: thumbnail.mimeType,
    },
  };
}

function failureCode(error: unknown): ObservationWorkerFailureCode {
  if (error instanceof SourceObservationDecodeError) return error.code;
  if (error instanceof ObservationThumbnailError) {
    if (error.code === 'unsupported-artifact') return 'thumbnail-unsupported';
    if (error.code === 'artifact-too-large') return 'thumbnail-too-large';
    return 'thumbnail-failed';
  }
  if (error instanceof ObservationWorkerConsumerTimeoutError) return 'consumer-timeout';
  return 'worker-failed';
}

class ObservationWorkerCancelledError extends Error {}
class ObservationWorkerConsumerTimeoutError extends Error {}

function extractSafeJobId(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const jobId = (value as { jobId?: unknown }).jobId;
  return typeof jobId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId)
    ? jobId
    : undefined;
}

const workerScope = globalThis as unknown as ObservationWorkerScope;
new ObservationWorkerRuntime(workerScope).listen();
