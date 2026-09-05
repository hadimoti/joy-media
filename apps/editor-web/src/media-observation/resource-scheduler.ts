/**
 * Bounded ownership for decoded observation resources. This scheduler has no
 * decoder knowledge: callers must close their frame/bitmap/audio resource when
 * a lease ends, and should not start an expensive decode after backpressure.
 */
export type ObservationResourcePriority = 'playback' | 'interactive' | 'background';

export interface ObservationResourceSchedulerOptions {
  readonly maxWorkingSetBytes: number;
  readonly maxInFlight: number;
}

export interface ObservationResourceRequest {
  readonly id: string;
  readonly bytes: number;
  readonly epoch: number;
  readonly priority: ObservationResourcePriority;
}

export interface ObservationResourceLease {
  readonly state: 'acquired';
  readonly id: string;
  readonly bytes: number;
  readonly epoch: number;
  release(): boolean;
}

export type ObservationResourceDecision =
  | ObservationResourceLease
  | {
      readonly state: 'backpressure';
      readonly reason: 'working-set-budget' | 'in-flight-budget' | 'playback-priority';
    };

export interface ObservationResourceSnapshot {
  readonly activeCount: number;
  readonly workingSetBytes: number;
  readonly activePlaybackCount: number;
}

interface ActiveLease extends ObservationResourceRequest {
  released: boolean;
}

export class ObservationResourceScheduler {
  readonly #active = new Map<string, ActiveLease>();
  #workingSetBytes = 0;

  constructor(private readonly options: ObservationResourceSchedulerOptions) {
    if (!Number.isSafeInteger(options.maxWorkingSetBytes) || options.maxWorkingSetBytes < 1)
      throw new RangeError('maxWorkingSetBytes must be a positive safe integer');
    if (!Number.isSafeInteger(options.maxInFlight) || options.maxInFlight < 1)
      throw new RangeError('maxInFlight must be a positive safe integer');
  }

  tryAcquire(request: ObservationResourceRequest): ObservationResourceDecision {
    assertRequest(request);
    if (request.priority === 'background' && this.#hasPlaybackLease())
      return { state: 'backpressure', reason: 'playback-priority' };
    if (this.#active.size >= this.options.maxInFlight)
      return { state: 'backpressure', reason: 'in-flight-budget' };
    if (request.bytes > this.options.maxWorkingSetBytes - this.#workingSetBytes)
      return { state: 'backpressure', reason: 'working-set-budget' };
    if (this.#active.has(request.id))
      throw new Error(`observation resource ${request.id} is already active`);

    const active: ActiveLease = { ...request, released: false };
    this.#active.set(active.id, active);
    this.#workingSetBytes += active.bytes;
    return {
      state: 'acquired',
      id: active.id,
      bytes: active.bytes,
      epoch: active.epoch,
      release: () => this.#release(active.id),
    };
  }

  cancelEpoch(epoch: number): readonly string[] {
    if (!Number.isSafeInteger(epoch) || epoch < 0)
      throw new RangeError('epoch must be a non-negative safe integer');
    const cancelled: string[] = [];
    for (const active of [...this.#active.values()]) {
      if (active.epoch === epoch && this.#release(active.id)) cancelled.push(active.id);
    }
    return cancelled;
  }

  snapshot(): ObservationResourceSnapshot {
    return {
      activeCount: this.#active.size,
      workingSetBytes: this.#workingSetBytes,
      activePlaybackCount: [...this.#active.values()].filter(
        (active) => active.priority === 'playback',
      ).length,
    };
  }

  #hasPlaybackLease(): boolean {
    return [...this.#active.values()].some((active) => active.priority === 'playback');
  }

  #release(id: string): boolean {
    const active = this.#active.get(id);
    if (active === undefined || active.released) return false;
    active.released = true;
    this.#active.delete(id);
    this.#workingSetBytes -= active.bytes;
    return true;
  }
}

function assertRequest(request: ObservationResourceRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.id))
    throw new RangeError('id must be a bounded opaque identifier');
  if (!Number.isSafeInteger(request.bytes) || request.bytes < 1)
    throw new RangeError('bytes must be a positive safe integer');
  if (!Number.isSafeInteger(request.epoch) || request.epoch < 0)
    throw new RangeError('epoch must be a non-negative safe integer');
}
