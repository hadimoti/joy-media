import {
  validateCreativeBriefV2Request,
  validateCreativeBriefV2Result,
  type CreativeBriefV2Request,
  type CreativeBriefV2Result,
} from './creative-brief-v2.js';

export const DEFAULT_CREATIVE_BRIEF_V2_TIMEOUT_MS = 30_000;
export const MAX_CREATIVE_BRIEF_V2_TIMEOUT_MS = 120_000;

const MAX_RUNTIME_IDENTIFIER_LENGTH = 256;
const SAFE_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ABORTED = Symbol('creative-brief-v2-aborted');

export type CreativeBriefV2AdapterFailureCategory =
  'unavailable' | 'policy-denied' | 'provider-failed';

export type CreativeBriefV2AdapterOutcome =
  | {
      readonly category: 'ready';
      readonly result: unknown;
    }
  | {
      readonly category: CreativeBriefV2AdapterFailureCategory;
      readonly retryable: boolean;
      readonly errorCode?: string;
    };

export interface CreativeBriefV2AdapterContext {
  readonly correlationId: string;
  readonly signal: AbortSignal;
}

/**
 * Provider-neutral asynchronous boundary. Implementations may perform I/O, but
 * this package neither selects a provider nor grants network or mutation authority.
 */
export interface CreativeBriefV2AsyncAdapter {
  readonly adapterName: string;
  createBrief(
    request: CreativeBriefV2Request,
    context: CreativeBriefV2AdapterContext,
  ): Promise<CreativeBriefV2AdapterOutcome>;
}

export type CreativeBriefV2RuntimeCategory =
  | 'ready'
  | 'invalid-request'
  | 'unavailable'
  | 'policy-denied'
  | 'invalid-output'
  | 'provider-failed'
  | 'timeout'
  | 'cancelled';

interface CreativeBriefV2RuntimeOutcomeBase {
  readonly category: CreativeBriefV2RuntimeCategory;
  readonly retryable: boolean;
  readonly durationMs: number;
}

export interface CreativeBriefV2RuntimeReadyOutcome extends CreativeBriefV2RuntimeOutcomeBase {
  readonly category: 'ready';
  readonly retryable: false;
  readonly result: CreativeBriefV2Result;
}

export interface CreativeBriefV2RuntimeFailureOutcome extends CreativeBriefV2RuntimeOutcomeBase {
  readonly category: Exclude<CreativeBriefV2RuntimeCategory, 'ready'>;
  readonly errorCode?: string;
}

export type CreativeBriefV2RuntimeOutcome =
  CreativeBriefV2RuntimeReadyOutcome | CreativeBriefV2RuntimeFailureOutcome;

type CreativeBriefV2RuntimeOutcomeWithoutDuration =
  | {
      readonly category: 'ready';
      readonly retryable: false;
      readonly result: CreativeBriefV2Result;
    }
  | {
      readonly category: Exclude<CreativeBriefV2RuntimeCategory, 'ready'>;
      readonly retryable: boolean;
      readonly errorCode?: string;
    };

export type CreativeBriefV2AuditEvent =
  | {
      readonly eventType: 'start';
      readonly correlationId: string;
      readonly adapterName: string;
    }
  | {
      readonly eventType: 'end';
      readonly correlationId: string;
      readonly adapterName: string;
      readonly category: CreativeBriefV2RuntimeCategory;
      readonly durationMs: number;
      readonly errorCode?: string;
    };

export interface CreativeBriefV2AuditSink {
  emit(event: CreativeBriefV2AuditEvent): void;
}

export interface CreativeBriefV2RuntimeOptions {
  readonly correlationId: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly auditSink?: CreativeBriefV2AuditSink;
  readonly now?: () => number;
}

/**
 * Validates and executes one read-only Creative Brief v2 request.
 *
 * Provider exceptions and output contents never cross this boundary. The only
 * provider-controlled failure metadata retained is a constrained error code.
 */
export async function executeCreativeBriefV2(
  request: unknown,
  adapter: CreativeBriefV2AsyncAdapter,
  options: CreativeBriefV2RuntimeOptions,
): Promise<CreativeBriefV2RuntimeOutcome> {
  const timeoutMs = validateRuntimeOptions(adapter, options);
  const now = options.now ?? Date.now;
  const startedAt = now();
  emitAudit(options.auditSink, {
    eventType: 'start',
    correlationId: options.correlationId,
    adapterName: adapter.adapterName,
  });

  const finish = (
    outcome: CreativeBriefV2RuntimeOutcomeWithoutDuration,
  ): CreativeBriefV2RuntimeOutcome => {
    const completed = { ...outcome, durationMs: Math.max(0, now() - startedAt) } as
      CreativeBriefV2RuntimeReadyOutcome | CreativeBriefV2RuntimeFailureOutcome;
    emitAudit(options.auditSink, {
      eventType: 'end',
      correlationId: options.correlationId,
      adapterName: adapter.adapterName,
      category: completed.category,
      durationMs: completed.durationMs,
      ...(completed.category !== 'ready' && completed.errorCode !== undefined
        ? { errorCode: completed.errorCode }
        : {}),
    });
    return completed;
  };

  const validation = validateCreativeBriefV2Request(request);
  if (!validation.valid) {
    return finish({ category: 'invalid-request', retryable: false });
  }
  const validatedRequest = request as CreativeBriefV2Request;

  if (options.signal?.aborted === true) {
    return finish({ category: 'cancelled', retryable: false });
  }

  const controller = new AbortController();
  let timedOut = false;
  const relayCancellation = (): void => controller.abort();
  options.signal?.addEventListener('abort', relayCancellation, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const abortPromise = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(ABORTED), { once: true });
    });
    const adapterPromise = Promise.resolve().then(() =>
      adapter.createBrief(validatedRequest, {
        correlationId: options.correlationId,
        signal: controller.signal,
      }),
    );
    const adapterOutcome = await Promise.race([adapterPromise, abortPromise]);

    if (!isAdapterOutcome(adapterOutcome)) {
      return finish({ category: 'provider-failed', retryable: true });
    }

    if (adapterOutcome.category !== 'ready') {
      const errorCode = safeErrorCode(adapterOutcome.errorCode);
      return finish({
        category: adapterOutcome.category,
        retryable: adapterOutcome.retryable,
        ...(errorCode === undefined ? {} : { errorCode }),
      });
    }

    const outputValidation = validateCreativeBriefV2Result(adapterOutcome.result, validatedRequest);
    if (!outputValidation.valid) {
      return finish({ category: 'invalid-output', retryable: false });
    }
    return finish({
      category: 'ready',
      retryable: false,
      result: adapterOutcome.result as CreativeBriefV2Result,
    });
  } catch (error) {
    if (error === ABORTED) {
      return finish({
        category: timedOut ? 'timeout' : 'cancelled',
        retryable: timedOut,
      });
    }
    return finish({ category: 'provider-failed', retryable: true });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', relayCancellation);
  }
}

function validateRuntimeOptions(
  adapter: CreativeBriefV2AsyncAdapter,
  options: CreativeBriefV2RuntimeOptions,
): number {
  assertRuntimeIdentifier(adapter.adapterName, 'adapterName');
  assertRuntimeIdentifier(options.correlationId, 'correlationId');
  const timeoutMs = options.timeoutMs ?? DEFAULT_CREATIVE_BRIEF_V2_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_CREATIVE_BRIEF_V2_TIMEOUT_MS
  ) {
    throw new TypeError(
      `timeoutMs must be a positive safe integer no greater than ${MAX_CREATIVE_BRIEF_V2_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

function assertRuntimeIdentifier(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_RUNTIME_IDENTIFIER_LENGTH ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(`${name} must be a bounded non-empty identifier`);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function safeErrorCode(value: string | undefined): string | undefined {
  return value !== undefined && SAFE_ERROR_CODE.test(value) ? value : undefined;
}

function isAdapterOutcome(value: unknown): value is CreativeBriefV2AdapterOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.category === 'ready') return 'result' in candidate;
  return (
    (candidate.category === 'unavailable' ||
      candidate.category === 'policy-denied' ||
      candidate.category === 'provider-failed') &&
    typeof candidate.retryable === 'boolean' &&
    (candidate.errorCode === undefined || typeof candidate.errorCode === 'string')
  );
}

function emitAudit(
  sink: CreativeBriefV2AuditSink | undefined,
  event: CreativeBriefV2AuditEvent,
): void {
  try {
    sink?.emit(event);
  } catch {
    // Audit consumers are observational and cannot change runtime outcomes.
  }
}
