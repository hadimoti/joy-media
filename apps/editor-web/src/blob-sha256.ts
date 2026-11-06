import { createSha256 } from '@joy-media/workflow-engine';

/** How many bytes of a Blob are read at a time while it is hashed. */
const HASH_SLICE_BYTES = 8 * 1024 * 1024;

export interface Sha256OfBlobOptions {
  readonly signal?: AbortSignal;
  readonly sliceBytes?: number;
  /**
   * Supplies the worker that hashes the Blob. Tests inject a stand-in; production uses the dedicated module worker.
   * Without it and without a Worker global (test runners), the Blob is hashed on this thread.
   */
  readonly createWorker?: () => Worker;
}

/** What the hashing worker receives: one Blob to hash. */
export interface HashRequest {
  readonly blob: Blob;
  readonly sliceBytes?: number | undefined;
}

/** What the hashing worker posts back: the digest, or the reason it could not be computed. */
export type HashReply = { readonly digest: string } | { readonly error: string };

/**
 * SHA-256 of a Blob, as lowercase hex, computed on the calling thread.
 *
 * The Blob is read in slices, so the whole file is never copied into script memory as one buffer.
 * The browser can only hash a whole buffer natively, so this uses the workflow engine's streaming
 * SHA-256; for the same bytes it gives the same digest that `crypto.subtle` would.
 */
export async function sha256OfBlobOnThisThread(
  blob: Blob,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly sliceBytes?: number | undefined;
  } = {},
): Promise<string> {
  checkSliceBytes(options.sliceBytes);
  const hasher = createSha256();
  const sliceBytes = options.sliceBytes ?? HASH_SLICE_BYTES;
  for (let offset = 0; offset < blob.size; offset += sliceBytes) {
    options.signal?.throwIfAborted();
    const slice = blob.slice(offset, Math.min(blob.size, offset + sliceBytes));
    hasher.update(new Uint8Array(await slice.arrayBuffer()));
  }
  options.signal?.throwIfAborted();
  return hasher.hexDigest();
}

/** The worker script's whole job: hash one request and say how it ended. It never throws past its caller. */
export async function answerHashRequest(request: HashRequest): Promise<HashReply> {
  try {
    return {
      digest: await sha256OfBlobOnThisThread(request.blob, { sliceBytes: request.sliceBytes }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * SHA-256 of a Blob, as lowercase hex, hashed in a dedicated worker so that a large export does not stall the UI
 * thread. Aborting the signal terminates the worker, which stops the hashing at once.
 */
export async function sha256OfBlob(blob: Blob, options: Sha256OfBlobOptions = {}): Promise<string> {
  checkSliceBytes(options.sliceBytes);
  options.signal?.throwIfAborted();
  if (options.createWorker === undefined && typeof Worker === 'undefined') {
    return sha256OfBlobOnThisThread(blob, options);
  }
  const worker = (options.createWorker ?? createHashWorker)();
  return new Promise<string>((resolve, reject) => {
    const finish = (): void => {
      options.signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    const onAbort = (): void => {
      finish();
      reject(options.signal?.reason ?? new DOMException('The hash was aborted.', 'AbortError'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<HashReply>) => {
      finish();
      const reply = event.data;
      if ('digest' in reply) resolve(reply.digest);
      else reject(new Error(reply.error));
    };
    worker.onerror = (event: ErrorEvent) => {
      finish();
      reject(new Error(event.message || 'The hashing worker failed.'));
    };
    const request: HashRequest = { blob, sliceBytes: options.sliceBytes };
    worker.postMessage(request);
  });
}

function createHashWorker(): Worker {
  return new Worker(new URL('./blob-sha256.worker.ts', import.meta.url), {
    type: 'module',
    name: 'joy-blob-sha256',
  });
}

function checkSliceBytes(sliceBytes: number | undefined): void {
  if (sliceBytes !== undefined && (!Number.isSafeInteger(sliceBytes) || sliceBytes <= 0))
    throw new RangeError('sliceBytes must be a positive safe integer');
}
