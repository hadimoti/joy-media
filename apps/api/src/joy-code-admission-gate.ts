export type JoyCodeAdmissionDeniedCode =
  | 'JOY_CODE_IN_FLIGHT'
  | 'JOY_CODE_CONCURRENCY_LIMIT'
  | 'JOY_CODE_RATE_LIMIT'
  | 'JOY_CODE_DAILY_LIMIT'
  | 'JOY_CODE_CIRCUIT_OPEN';

export type JoyCodeAdmissionResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: JoyCodeAdmissionDeniedCode };

export interface JoyCodeAdmissionGateOptions {
  readonly maxConcurrent?: number;
  readonly perMinute?: number;
  readonly perDay?: number;
  readonly failureThreshold?: number;
  readonly circuitCooldownMs?: number;
}

const DEFAULTS = {
  maxConcurrent: 1,
  perMinute: 3,
  perDay: 20,
  failureThreshold: 3,
  circuitCooldownMs: 60_000,
} as const;

/** In-memory owner/project admission gate for the free-only Joy Code planner. */
export class JoyCodeAdmissionGate {
  readonly #maxConcurrent: number;
  readonly #perMinute: number;
  readonly #perDay: number;
  readonly #failureThreshold: number;
  readonly #circuitCooldownMs: number;
  readonly #inFlight = new Set<string>();
  readonly #minuteHistory = new Map<string, number[]>();
  readonly #dayHistory = new Map<string, number[]>();
  #concurrent = 0;
  #providerFailures = 0;
  #circuitOpenedAt: number | undefined;
  #lastNow = 0;

  constructor(options: JoyCodeAdmissionGateOptions = {}) {
    this.#maxConcurrent = options.maxConcurrent ?? DEFAULTS.maxConcurrent;
    this.#perMinute = options.perMinute ?? DEFAULTS.perMinute;
    this.#perDay = options.perDay ?? DEFAULTS.perDay;
    this.#failureThreshold = options.failureThreshold ?? DEFAULTS.failureThreshold;
    this.#circuitCooldownMs = options.circuitCooldownMs ?? DEFAULTS.circuitCooldownMs;
  }

  admit(ownerId: string, projectId: string, now: number): JoyCodeAdmissionResult {
    this.#lastNow = now;
    if (
      this.#circuitOpenedAt !== undefined &&
      now - this.#circuitOpenedAt < this.#circuitCooldownMs
    )
      return { allowed: false, code: 'JOY_CODE_CIRCUIT_OPEN' };
    if (this.#circuitOpenedAt !== undefined) {
      this.#circuitOpenedAt = undefined;
      this.#providerFailures = 0;
    }
    const key = `${ownerId}\u0000${projectId}`;
    if (this.#inFlight.has(key)) return { allowed: false, code: 'JOY_CODE_IN_FLIGHT' };
    if (this.#concurrent >= this.#maxConcurrent)
      return { allowed: false, code: 'JOY_CODE_CONCURRENCY_LIMIT' };
    const minute = this.#prune(this.#minuteHistory, ownerId, now - 60_000);
    if (minute.length >= this.#perMinute) return { allowed: false, code: 'JOY_CODE_RATE_LIMIT' };
    const day = this.#prune(this.#dayHistory, ownerId, now - 86_400_000);
    if (day.length >= this.#perDay) return { allowed: false, code: 'JOY_CODE_DAILY_LIMIT' };
    minute.push(now);
    day.push(now);
    this.#inFlight.add(key);
    this.#concurrent += 1;
    return { allowed: true };
  }

  release(ownerId: string, projectId: string): void {
    const key = `${ownerId}\u0000${projectId}`;
    if (this.#inFlight.delete(key)) this.#concurrent -= 1;
  }

  recordOutcome(category: 'ready' | 'provider-failed' | string, now = this.#lastNow): void {
    if (category === 'provider-failed') {
      this.#providerFailures += 1;
      if (this.#providerFailures >= this.#failureThreshold) this.#circuitOpenedAt = now;
      return;
    }
    if (category === 'ready') {
      this.#providerFailures = 0;
      this.#circuitOpenedAt = undefined;
    }
  }

  #prune(history: Map<string, number[]>, ownerId: string, cutoff: number): number[] {
    const retained = (history.get(ownerId) ?? []).filter((timestamp) => timestamp > cutoff);
    history.set(ownerId, retained);
    return retained;
  }
}
