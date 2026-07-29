/**
 * Keeps the asset grid from spawning one rclone-backed request per rendered
 * card. The key also coalesces callers that ask for the same original.
 */
export class CloudPreviewQueue {
  readonly #pending: Array<{
    readonly load: () => Promise<Blob>;
    readonly resolve: (value: Blob) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  readonly #inFlight = new Map<string, Promise<Blob>>();
  #active = 0;

  constructor(private readonly concurrency = 6) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1)
      throw new TypeError('preview concurrency must be a positive integer');
  }

  load(key: string, request: () => Promise<Blob>): Promise<Blob> {
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) return existing;

    let resolve!: (value: Blob) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<Blob>((resolveResult, rejectResult) => {
      resolve = resolveResult;
      reject = rejectResult;
    });
    this.#inFlight.set(key, result);
    result.then(
      () => this.#inFlight.delete(key),
      () => this.#inFlight.delete(key),
    );
    this.#pending.push({ load: request, resolve, reject });
    this.#drain();
    return result;
  }

  #drain(): void {
    while (this.#active < this.concurrency && this.#pending.length > 0) {
      const next = this.#pending.shift();
      if (next === undefined) return;
      this.#active += 1;
      void Promise.resolve()
        .then(next.load)
        .then(
          (value) => {
            this.#complete();
            next.resolve(value);
          },
          (error: unknown) => {
            this.#complete();
            next.reject(error);
          },
        );
    }
  }

  #complete(): void {
    this.#active -= 1;
    this.#drain();
  }
}
