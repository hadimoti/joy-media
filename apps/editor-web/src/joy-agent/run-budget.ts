export const JOY_AGENT_RUN_BUDGET_VERSION = 1 as const;

/** V1 hard caps mirror the currently deployed browser Worker boundaries. */
export const MAX_JOY_AGENT_RUN_BUDGET_V1 = Object.freeze({
  maxToolSteps: 8,
  maxOutputBytes: 2 * 1024 * 1024,
  maxWallTimeMs: 60_000,
  maxRepairAttempts: 2,
});

export interface JoyAgentRunBudgetV1 {
  readonly version: typeof JOY_AGENT_RUN_BUDGET_VERSION;
  readonly maxToolSteps: number;
  readonly maxOutputBytes: number;
  readonly maxWallTimeMs: number;
  readonly maxRepairAttempts: number;
}

export const DEFAULT_JOY_AGENT_RUN_BUDGET: JoyAgentRunBudgetV1 = Object.freeze({
  version: JOY_AGENT_RUN_BUDGET_VERSION,
  ...MAX_JOY_AGENT_RUN_BUDGET_V1,
});

export interface JoyAgentRunBudgetStateV1 {
  readonly version: typeof JOY_AGENT_RUN_BUDGET_VERSION;
  readonly budget: JoyAgentRunBudgetV1;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly lastDecisionAtMs: number;
  readonly usage: {
    readonly toolSteps: number;
    readonly outputBytes: number;
    readonly repairAttempts: number;
  };
  readonly cancellation?: JoyAgentRunBudgetCancellation;
}

export type JoyAgentRunBudgetCancellationReason =
  | 'tool-steps-exhausted'
  | 'output-bytes-exhausted'
  | 'repair-attempts-exhausted'
  | 'externally-cancelled'
  | 'wall-time-exhausted';

export interface JoyAgentRunBudgetCancellation {
  readonly reason: JoyAgentRunBudgetCancellationReason;
  readonly atMs: number;
}

export type JoyAgentRunBudgetAction =
  | { readonly kind: 'tool-step'; readonly atMs: number }
  | { readonly kind: 'output-bytes'; readonly bytes: number; readonly atMs: number }
  | { readonly kind: 'repair-attempt'; readonly atMs: number }
  | { readonly kind: 'cancel'; readonly atMs: number }
  | { readonly kind: 'check'; readonly atMs: number };

export type JoyAgentRunBudgetDecision =
  | { readonly kind: 'continue'; readonly state: JoyAgentRunBudgetStateV1 }
  | {
      readonly kind: 'cancel';
      readonly reason: JoyAgentRunBudgetCancellationReason;
      readonly state: JoyAgentRunBudgetStateV1;
    };

export function parseJoyAgentRunBudget(value: unknown): JoyAgentRunBudgetV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'maxToolSteps',
      'maxOutputBytes',
      'maxWallTimeMs',
      'maxRepairAttempts',
    ]) ||
    value.version !== JOY_AGENT_RUN_BUDGET_VERSION ||
    !isSafeNonNegativeInteger(value.maxToolSteps) ||
    value.maxToolSteps > MAX_JOY_AGENT_RUN_BUDGET_V1.maxToolSteps ||
    !isSafePositiveInteger(value.maxOutputBytes) ||
    value.maxOutputBytes > MAX_JOY_AGENT_RUN_BUDGET_V1.maxOutputBytes ||
    !isSafePositiveInteger(value.maxWallTimeMs) ||
    value.maxWallTimeMs > MAX_JOY_AGENT_RUN_BUDGET_V1.maxWallTimeMs ||
    !isSafeNonNegativeInteger(value.maxRepairAttempts) ||
    value.maxRepairAttempts > MAX_JOY_AGENT_RUN_BUDGET_V1.maxRepairAttempts
  ) {
    throw new Error('JOY_AGENT_INVALID_RUN_BUDGET');
  }
  return Object.freeze({
    version: JOY_AGENT_RUN_BUDGET_VERSION,
    maxToolSteps: value.maxToolSteps,
    maxOutputBytes: value.maxOutputBytes,
    maxWallTimeMs: value.maxWallTimeMs,
    maxRepairAttempts: value.maxRepairAttempts,
  });
}

export function createJoyAgentRunBudgetState(
  budget: JoyAgentRunBudgetV1,
  startedAtMs: number,
): JoyAgentRunBudgetStateV1 {
  const parsedBudget = parseJoyAgentRunBudget(budget);
  if (!isSafeNonNegativeInteger(startedAtMs)) throw new Error('JOY_AGENT_INVALID_RUN_BUDGET');
  const deadlineAtMs = startedAtMs + parsedBudget.maxWallTimeMs;
  if (!Number.isSafeInteger(deadlineAtMs)) throw new Error('JOY_AGENT_INVALID_RUN_BUDGET');
  return createState(parsedBudget, startedAtMs, deadlineAtMs, startedAtMs, {
    toolSteps: 0,
    outputBytes: 0,
    repairAttempts: 0,
  });
}

/**
 * Parse untrusted persisted or cross-thread state before making a decision.
 * A mismatched deadline or exhausted counter can never be repaired by simply
 * continuing the run.
 */
export function parseJoyAgentRunBudgetState(value: unknown): JoyAgentRunBudgetStateV1 {
  if (
    !isRecord(value) ||
    !(
      hasExactKeys(value, [
        'version',
        'budget',
        'startedAtMs',
        'deadlineAtMs',
        'lastDecisionAtMs',
        'usage',
      ]) ||
      hasExactKeys(value, [
        'version',
        'budget',
        'startedAtMs',
        'deadlineAtMs',
        'lastDecisionAtMs',
        'usage',
        'cancellation',
      ])
    ) ||
    value.version !== JOY_AGENT_RUN_BUDGET_VERSION ||
    !isSafeNonNegativeInteger(value.startedAtMs) ||
    !isSafeNonNegativeInteger(value.deadlineAtMs) ||
    !isSafeNonNegativeInteger(value.lastDecisionAtMs)
  ) {
    throw new Error('JOY_AGENT_INVALID_RUN_BUDGET');
  }
  const hasCancellation = Object.prototype.hasOwnProperty.call(value, 'cancellation');
  if (hasCancellation && value.cancellation === undefined) {
    throw new Error('JOY_AGENT_INVALID_RUN_BUDGET');
  }
  const budget = parseJoyAgentRunBudget(value.budget);
  const deadlineAtMs = value.startedAtMs + budget.maxWallTimeMs;
  if (
    !Number.isSafeInteger(deadlineAtMs) ||
    value.deadlineAtMs !== deadlineAtMs ||
    value.lastDecisionAtMs < value.startedAtMs ||
    value.lastDecisionAtMs > deadlineAtMs ||
    !isRecord(value.usage) ||
    !hasExactKeys(value.usage, ['toolSteps', 'outputBytes', 'repairAttempts']) ||
    !isSafeNonNegativeInteger(value.usage.toolSteps) ||
    value.usage.toolSteps > budget.maxToolSteps ||
    !isSafeNonNegativeInteger(value.usage.outputBytes) ||
    value.usage.outputBytes > budget.maxOutputBytes ||
    !isSafeNonNegativeInteger(value.usage.repairAttempts) ||
    value.usage.repairAttempts > budget.maxRepairAttempts
  ) {
    throw new Error('JOY_AGENT_INVALID_RUN_BUDGET');
  }
  const cancellation = hasCancellation
    ? parseJoyAgentRunBudgetCancellation(value.cancellation)
    : undefined;
  if (cancellation === undefined && value.lastDecisionAtMs >= deadlineAtMs)
    throw new Error('JOY_AGENT_INVALID_RUN_BUDGET');
  if (cancellation !== undefined) {
    const reasonMatchesUsage =
      (cancellation.reason === 'tool-steps-exhausted' &&
        value.usage.toolSteps === budget.maxToolSteps) ||
      (cancellation.reason === 'output-bytes-exhausted' &&
        value.usage.outputBytes === budget.maxOutputBytes) ||
      (cancellation.reason === 'repair-attempts-exhausted' &&
        value.usage.repairAttempts === budget.maxRepairAttempts) ||
      (cancellation.reason === 'wall-time-exhausted' && cancellation.atMs === deadlineAtMs) ||
      cancellation.reason === 'externally-cancelled';
    if (
      cancellation.atMs !== value.lastDecisionAtMs ||
      cancellation.atMs < value.startedAtMs ||
      cancellation.atMs > deadlineAtMs ||
      !reasonMatchesUsage
    ) {
      throw new Error('JOY_AGENT_INVALID_RUN_BUDGET');
    }
  }
  return createState(
    budget,
    value.startedAtMs,
    deadlineAtMs,
    value.lastDecisionAtMs,
    {
      toolSteps: value.usage.toolSteps,
      outputBytes: value.usage.outputBytes,
      repairAttempts: value.usage.repairAttempts,
    },
    cancellation,
  );
}

export function consumeJoyAgentRunBudget(
  state: unknown,
  action: unknown,
): JoyAgentRunBudgetDecision {
  const parsedState = parseJoyAgentRunBudgetState(state);
  const parsedAction = parseJoyAgentRunBudgetAction(action);
  if (parsedAction.atMs < parsedState.lastDecisionAtMs)
    throw new Error('JOY_AGENT_INVALID_RUN_BUDGET');
  if (parsedState.cancellation !== undefined)
    return { kind: 'cancel', reason: parsedState.cancellation.reason, state: parsedState };
  // A timer may wake after the deadline. Record expiry at the immutable
  // deadline itself so the latched state remains valid and reproducible.
  if (parsedAction.atMs >= parsedState.deadlineAtMs)
    return cancel(parsedState, 'wall-time-exhausted', parsedState.deadlineAtMs);
  if (parsedAction.kind === 'cancel')
    return cancel(parsedState, 'externally-cancelled', parsedAction.atMs);
  if (parsedAction.kind === 'check') {
    return {
      kind: 'continue',
      state: createState(
        parsedState.budget,
        parsedState.startedAtMs,
        parsedState.deadlineAtMs,
        parsedAction.atMs,
        parsedState.usage,
      ),
    };
  }
  if (parsedAction.kind === 'output-bytes') {
    if (parsedState.usage.outputBytes + parsedAction.bytes > parsedState.budget.maxOutputBytes)
      return cancel(parsedState, 'output-bytes-exhausted', parsedAction.atMs);
    return {
      kind: 'continue',
      state: createState(
        parsedState.budget,
        parsedState.startedAtMs,
        parsedState.deadlineAtMs,
        parsedAction.atMs,
        { ...parsedState.usage, outputBytes: parsedState.usage.outputBytes + parsedAction.bytes },
      ),
    };
  }
  if (parsedAction.kind === 'repair-attempt') {
    if (parsedState.usage.repairAttempts >= parsedState.budget.maxRepairAttempts)
      return cancel(parsedState, 'repair-attempts-exhausted', parsedAction.atMs);
    return {
      kind: 'continue',
      state: createState(
        parsedState.budget,
        parsedState.startedAtMs,
        parsedState.deadlineAtMs,
        parsedAction.atMs,
        { ...parsedState.usage, repairAttempts: parsedState.usage.repairAttempts + 1 },
      ),
    };
  }
  if (parsedState.usage.toolSteps >= parsedState.budget.maxToolSteps)
    return cancel(parsedState, 'tool-steps-exhausted', parsedAction.atMs);
  return {
    kind: 'continue',
    state: createState(
      parsedState.budget,
      parsedState.startedAtMs,
      parsedState.deadlineAtMs,
      parsedAction.atMs,
      { ...parsedState.usage, toolSteps: parsedState.usage.toolSteps + 1 },
    ),
  };
}

function cancel(
  state: JoyAgentRunBudgetStateV1,
  reason: JoyAgentRunBudgetCancellationReason,
  atMs: number,
): JoyAgentRunBudgetDecision {
  const next = createState(state.budget, state.startedAtMs, state.deadlineAtMs, atMs, state.usage, {
    reason,
    atMs,
  });
  return { kind: 'cancel', reason, state: next };
}

function parseJoyAgentRunBudgetAction(value: unknown): JoyAgentRunBudgetAction {
  if (!isRecord(value) || !isSafeNonNegativeInteger(value.atMs))
    throw new Error('JOY_AGENT_INVALID_RUN_BUDGET');
  if (value.kind === 'tool-step' && hasExactKeys(value, ['kind', 'atMs']))
    return { kind: 'tool-step', atMs: value.atMs };
  if (
    value.kind === 'output-bytes' &&
    hasExactKeys(value, ['kind', 'bytes', 'atMs']) &&
    isSafeNonNegativeInteger(value.bytes)
  ) {
    return { kind: 'output-bytes', bytes: value.bytes, atMs: value.atMs };
  }
  if (value.kind === 'repair-attempt' && hasExactKeys(value, ['kind', 'atMs']))
    return { kind: 'repair-attempt', atMs: value.atMs };
  if (value.kind === 'cancel' && hasExactKeys(value, ['kind', 'atMs']))
    return { kind: 'cancel', atMs: value.atMs };
  if (value.kind === 'check' && hasExactKeys(value, ['kind', 'atMs']))
    return { kind: 'check', atMs: value.atMs };
  throw new Error('JOY_AGENT_INVALID_RUN_BUDGET');
}

function parseJoyAgentRunBudgetCancellation(value: unknown): JoyAgentRunBudgetCancellation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['reason', 'atMs']) ||
    !isSafeNonNegativeInteger(value.atMs) ||
    ![
      'tool-steps-exhausted',
      'output-bytes-exhausted',
      'repair-attempts-exhausted',
      'externally-cancelled',
      'wall-time-exhausted',
    ].includes(value.reason as string)
  ) {
    throw new Error('JOY_AGENT_INVALID_RUN_BUDGET');
  }
  return { reason: value.reason as JoyAgentRunBudgetCancellationReason, atMs: value.atMs };
}

function createState(
  budget: JoyAgentRunBudgetV1,
  startedAtMs: number,
  deadlineAtMs: number,
  lastDecisionAtMs: number,
  usage: JoyAgentRunBudgetStateV1['usage'],
  cancellation?: JoyAgentRunBudgetCancellation,
): JoyAgentRunBudgetStateV1 {
  const next = {
    version: JOY_AGENT_RUN_BUDGET_VERSION,
    budget,
    startedAtMs,
    deadlineAtMs,
    lastDecisionAtMs,
    usage: Object.freeze({ ...usage }),
    ...(cancellation === undefined ? {} : { cancellation: Object.freeze({ ...cancellation }) }),
  };
  return Object.freeze(next);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value > 0;
}
