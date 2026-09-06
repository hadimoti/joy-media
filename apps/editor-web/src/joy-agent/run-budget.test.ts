import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JOY_AGENT_RUN_BUDGET,
  consumeJoyAgentRunBudget,
  createJoyAgentRunBudgetState,
  parseJoyAgentRunBudget,
} from './run-budget.js';

describe('JOY Agent run budget', () => {
  it('publishes the bounded production V1 defaults', () => {
    expect(DEFAULT_JOY_AGENT_RUN_BUDGET).toEqual({
      version: 1,
      maxToolSteps: 8,
      maxOutputBytes: 2 * 1024 * 1024,
      maxWallTimeMs: 60_000,
      maxRepairAttempts: 2,
    });
    expect(parseJoyAgentRunBudget(DEFAULT_JOY_AGENT_RUN_BUDGET)).toEqual(
      DEFAULT_JOY_AGENT_RUN_BUDGET,
    );
  });

  it('creates a versioned budget state and consumes one tool step deterministically', () => {
    const budget = parseJoyAgentRunBudget({
      version: 1,
      maxToolSteps: 2,
      maxOutputBytes: 1_024,
      maxWallTimeMs: 10_000,
      maxRepairAttempts: 1,
    });
    const initial = createJoyAgentRunBudgetState(budget, 1_000);

    const decision = consumeJoyAgentRunBudget(initial, {
      kind: 'tool-step',
      atMs: 1_001,
    });

    expect(decision).toEqual({
      kind: 'continue',
      state: {
        version: 1,
        budget,
        startedAtMs: 1_000,
        deadlineAtMs: 11_000,
        lastDecisionAtMs: 1_001,
        usage: { toolSteps: 1, outputBytes: 0, repairAttempts: 0 },
      },
    });
    expect(initial.usage.toolSteps).toBe(0);
  });

  it.each([
    { maxToolSteps: 9 },
    { maxOutputBytes: 2 * 1024 * 1024 + 1 },
    { maxWallTimeMs: 60_001 },
    { maxRepairAttempts: 3 },
    { maxToolSteps: 1.5 },
    { maxOutputBytes: 0 },
    { maxWallTimeMs: Number.NaN },
    { maxRepairAttempts: -1 },
    { version: 2 },
    { unexpected: true },
  ])('fails closed for an invalid V1 budget: %o', (override) => {
    expect(() =>
      parseJoyAgentRunBudget({
        version: 1,
        maxToolSteps: 2,
        maxOutputBytes: 1_024,
        maxWallTimeMs: 10_000,
        maxRepairAttempts: 1,
        ...override,
      }),
    ).toThrow('JOY_AGENT_INVALID_RUN_BUDGET');
  });

  it('accounts provider output bytes without charging a tool step', () => {
    const state = createJoyAgentRunBudgetState(
      parseJoyAgentRunBudget({
        version: 1,
        maxToolSteps: 2,
        maxOutputBytes: 8,
        maxWallTimeMs: 10_000,
        maxRepairAttempts: 1,
      }),
      500,
    );

    const decision = consumeJoyAgentRunBudget(state, {
      kind: 'output-bytes',
      bytes: 3,
      atMs: 501,
    });

    expect(decision).toMatchObject({
      kind: 'continue',
      state: {
        lastDecisionAtMs: 501,
        usage: { toolSteps: 0, outputBytes: 3, repairAttempts: 0 },
      },
    });
  });

  it('accounts a validation repair separately from tool execution', () => {
    const state = createJoyAgentRunBudgetState(
      parseJoyAgentRunBudget({
        version: 1,
        maxToolSteps: 2,
        maxOutputBytes: 8,
        maxWallTimeMs: 10_000,
        maxRepairAttempts: 1,
      }),
      500,
    );

    const decision = consumeJoyAgentRunBudget(state, {
      kind: 'repair-attempt',
      atMs: 501,
    });

    expect(decision).toMatchObject({
      kind: 'continue',
      state: {
        lastDecisionAtMs: 501,
        usage: { toolSteps: 0, outputBytes: 0, repairAttempts: 1 },
      },
    });
  });

  it('latches a deterministic cancellation instead of overrunning tool steps', () => {
    const state = createJoyAgentRunBudgetState(
      parseJoyAgentRunBudget({
        version: 1,
        maxToolSteps: 1,
        maxOutputBytes: 8,
        maxWallTimeMs: 10_000,
        maxRepairAttempts: 1,
      }),
      500,
    );
    const first = consumeJoyAgentRunBudget(state, { kind: 'tool-step', atMs: 501 });
    if (first.kind !== 'continue') throw new Error('Expected first tool step to continue');

    expect(consumeJoyAgentRunBudget(first.state, { kind: 'tool-step', atMs: 502 })).toEqual({
      kind: 'cancel',
      reason: 'tool-steps-exhausted',
      state: {
        ...first.state,
        lastDecisionAtMs: 502,
        cancellation: { reason: 'tool-steps-exhausted', atMs: 502 },
      },
    });
  });

  it('cancels at the exact deadline before charging a new action', () => {
    const state = createJoyAgentRunBudgetState(
      parseJoyAgentRunBudget({
        version: 1,
        maxToolSteps: 1,
        maxOutputBytes: 8,
        maxWallTimeMs: 10,
        maxRepairAttempts: 1,
      }),
      500,
    );

    expect(consumeJoyAgentRunBudget(state, { kind: 'tool-step', atMs: 510 })).toEqual({
      kind: 'cancel',
      reason: 'wall-time-exhausted',
      state: {
        ...state,
        lastDecisionAtMs: 510,
        cancellation: { reason: 'wall-time-exhausted', atMs: 510 },
      },
    });
  });

  it('latches a late timer wakeup at the immutable deadline', () => {
    const state = createJoyAgentRunBudgetState(
      parseJoyAgentRunBudget({
        version: 1,
        maxToolSteps: 1,
        maxOutputBytes: 8,
        maxWallTimeMs: 10,
        maxRepairAttempts: 1,
      }),
      500,
    );

    expect(consumeJoyAgentRunBudget(state, { kind: 'check', atMs: 530 })).toEqual({
      kind: 'cancel',
      reason: 'wall-time-exhausted',
      state: {
        ...state,
        lastDecisionAtMs: 510,
        cancellation: { reason: 'wall-time-exhausted', atMs: 510 },
      },
    });
  });

  it('latches output-byte exhaustion without charging an over-budget response', () => {
    const state = createJoyAgentRunBudgetState(
      parseJoyAgentRunBudget({
        version: 1,
        maxToolSteps: 1,
        maxOutputBytes: 2,
        maxWallTimeMs: 10_000,
        maxRepairAttempts: 1,
      }),
      500,
    );
    const first = consumeJoyAgentRunBudget(state, {
      kind: 'output-bytes',
      bytes: 2,
      atMs: 501,
    });
    if (first.kind !== 'continue') throw new Error('Expected output within budget to continue');

    expect(
      consumeJoyAgentRunBudget(first.state, {
        kind: 'output-bytes',
        bytes: 1,
        atMs: 502,
      }),
    ).toEqual({
      kind: 'cancel',
      reason: 'output-bytes-exhausted',
      state: {
        ...first.state,
        lastDecisionAtMs: 502,
        cancellation: { reason: 'output-bytes-exhausted', atMs: 502 },
      },
    });
  });

  it('latches repair-attempt exhaustion without treating it as another tool step', () => {
    const state = createJoyAgentRunBudgetState(
      parseJoyAgentRunBudget({
        version: 1,
        maxToolSteps: 1,
        maxOutputBytes: 8,
        maxWallTimeMs: 10_000,
        maxRepairAttempts: 1,
      }),
      500,
    );
    const first = consumeJoyAgentRunBudget(state, { kind: 'repair-attempt', atMs: 501 });
    if (first.kind !== 'continue') throw new Error('Expected first repair to continue');

    expect(consumeJoyAgentRunBudget(first.state, { kind: 'repair-attempt', atMs: 502 })).toEqual({
      kind: 'cancel',
      reason: 'repair-attempts-exhausted',
      state: {
        ...first.state,
        lastDecisionAtMs: 502,
        cancellation: { reason: 'repair-attempts-exhausted', atMs: 502 },
      },
    });
  });

  it('latches an external cancellation and keeps later consumption inert', () => {
    const state = createJoyAgentRunBudgetState(
      parseJoyAgentRunBudget({
        version: 1,
        maxToolSteps: 1,
        maxOutputBytes: 8,
        maxWallTimeMs: 10_000,
        maxRepairAttempts: 1,
      }),
      500,
    );
    const cancelled = consumeJoyAgentRunBudget(state, { kind: 'cancel', atMs: 501 });

    expect(cancelled).toEqual({
      kind: 'cancel',
      reason: 'externally-cancelled',
      state: {
        ...state,
        lastDecisionAtMs: 501,
        cancellation: { reason: 'externally-cancelled', atMs: 501 },
      },
    });
    if (cancelled.kind !== 'cancel') throw new Error('Expected cancellation');
    expect(consumeJoyAgentRunBudget(cancelled.state, { kind: 'tool-step', atMs: 502 })).toEqual(
      cancelled,
    );
  });

  it('checks a deadline without charging any quota', () => {
    const state = createJoyAgentRunBudgetState(
      parseJoyAgentRunBudget({
        version: 1,
        maxToolSteps: 1,
        maxOutputBytes: 8,
        maxWallTimeMs: 10,
        maxRepairAttempts: 1,
      }),
      500,
    );

    expect(consumeJoyAgentRunBudget(state, { kind: 'check', atMs: 509 })).toEqual({
      kind: 'continue',
      state: { ...state, lastDecisionAtMs: 509 },
    });
  });

  it('fails closed when a forged state no longer matches its immutable deadline', () => {
    const state = createJoyAgentRunBudgetState(
      parseJoyAgentRunBudget({
        version: 1,
        maxToolSteps: 1,
        maxOutputBytes: 8,
        maxWallTimeMs: 10,
        maxRepairAttempts: 1,
      }),
      500,
    );

    expect(() =>
      consumeJoyAgentRunBudget({ ...state, deadlineAtMs: 511 }, { kind: 'check', atMs: 501 }),
    ).toThrow('JOY_AGENT_INVALID_RUN_BUDGET');
  });

  it('rejects an explicitly undefined cancellation field in the wire state', () => {
    const state = createJoyAgentRunBudgetState(DEFAULT_JOY_AGENT_RUN_BUDGET, 500);

    expect(() =>
      consumeJoyAgentRunBudget({ ...state, cancellation: undefined }, { kind: 'check', atMs: 501 }),
    ).toThrow('JOY_AGENT_INVALID_RUN_BUDGET');
  });

  it('rejects an unlatched state that claims it has already reached its deadline', () => {
    const state = createJoyAgentRunBudgetState(
      parseJoyAgentRunBudget({
        version: 1,
        maxToolSteps: 1,
        maxOutputBytes: 8,
        maxWallTimeMs: 10,
        maxRepairAttempts: 1,
      }),
      500,
    );

    expect(() =>
      consumeJoyAgentRunBudget(
        { ...state, lastDecisionAtMs: state.deadlineAtMs },
        { kind: 'check', atMs: state.deadlineAtMs },
      ),
    ).toThrow('JOY_AGENT_INVALID_RUN_BUDGET');
  });

  it('rejects a cancellation supplied only through an inherited property', () => {
    const state = createJoyAgentRunBudgetState(DEFAULT_JOY_AGENT_RUN_BUDGET, 500);
    const forged = Object.assign(
      Object.create({ cancellation: { reason: 'externally-cancelled', atMs: 500 } }),
      state,
    );

    expect(() => consumeJoyAgentRunBudget(forged, { kind: 'check', atMs: 501 })).toThrow(
      'JOY_AGENT_INVALID_RUN_BUDGET',
    );
  });
});
