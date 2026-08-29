/**
 * A small client-side polling controller for status projections. It keeps one
 * request in flight, pauses entirely in a hidden document, and makes repeated
 * failures progressively less expensive for the control plane.
 */
export const VISIBLE_POLL_INTERVAL_MS = 10_000;
export const MAX_POLL_BACKOFF_MS = 60_000;
/** Desynchronizes clients that fail at the same time without changing the success cadence. */
export const FAILURE_POLL_JITTER_RATIO = 0.1;

export interface PollingTimer {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export class BoundedPollingLoop {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<void> | undefined;
  #visible = true;
  #failureCount = 0;
  #refreshAfterFlight = false;
  #stopped = false;
  #started = false;

  constructor(
    private readonly poll: () => Promise<void>,
    private readonly timer: PollingTimer = globalThis,
    private readonly random: () => number = Math.random,
  ) {}

  /** Starts with an immediate request. Repeated starts are intentionally harmless. */
  start(): void {
    if (this.#stopped || this.#started) return;
    this.#started = true;
    void this.refresh().catch(() => undefined);
  }

  /**
   * Requests an immediate refresh when visible. If a request is already in
   * flight, the next request is run once it settles rather than in parallel.
   */
  refresh(): Promise<void> {
    if (this.#stopped || !this.#visible) return Promise.resolve();
    this.#clearTimer();
    if (this.#inFlight !== undefined) {
      this.#refreshAfterFlight = true;
      return this.#inFlight;
    }
    return this.#run();
  }

  /** Pauses background polling; foregrounding refreshes status immediately. */
  setVisible(visible: boolean): Promise<void> {
    if (this.#stopped || this.#visible === visible) return Promise.resolve();
    this.#visible = visible;
    this.#clearTimer();
    if (!visible) {
      // A manual refresh requested while the tab was still visible must not
      // become a surprise second request when the tab is foregrounded later.
      this.#refreshAfterFlight = false;
      return Promise.resolve();
    }
    return this.refresh();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimer();
    this.#refreshAfterFlight = false;
  }

  #run(): Promise<void> {
    if (this.#inFlight !== undefined) return this.#inFlight;
    const request = Promise.resolve().then(this.poll);
    const completion = request
      .then(
        () => {
          this.#failureCount = 0;
        },
        (error: unknown) => {
          this.#failureCount += 1;
          throw error;
        },
      )
      .finally(() => {
        this.#inFlight = undefined;
        if (this.#stopped || !this.#visible) return;
        if (this.#refreshAfterFlight) {
          this.#refreshAfterFlight = false;
          void this.#run().catch(() => undefined);
          return;
        }
        this.#schedule();
      });
    this.#inFlight = completion;
    return completion;
  }

  #schedule(): void {
    const baseDelay = Math.min(
      MAX_POLL_BACKOFF_MS,
      VISIBLE_POLL_INTERVAL_MS * 2 ** this.#failureCount,
    );
    // Keep healthy clients on the exact 10-second budget, but spread retries
    // after failures so one outage does not make every mounted panel wake up
    // on the same tick. Clamp the upper edge to the one-minute budget.
    const jitter =
      this.#failureCount === 0
        ? 0
        : (this.random() * 2 - 1) * FAILURE_POLL_JITTER_RATIO * baseDelay;
    const delay = Math.min(MAX_POLL_BACKOFF_MS, Math.max(0, baseDelay + jitter));
    this.#timer = this.timer.setTimeout(() => {
      this.#timer = undefined;
      if (this.#visible && !this.#stopped) void this.#run().catch(() => undefined);
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    this.timer.clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
