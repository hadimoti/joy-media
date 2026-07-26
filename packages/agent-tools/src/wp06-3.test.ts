import { describe, expect, it, beforeEach } from 'vitest';
import {
  createPlan,
  createToolRegistry,
  ApprovalEngine,
  createPermissiveApprovalPolicy,
  createDefaultApprovalPolicy,
  dryRunPlan,
  PlanExecutor,
  createIdempotencyStore,
  generateTransactionLabel,
  generateStepLabel,
  formatTransactionLabel,
  resolveExecutionOrder,
  canStepExecute,
  getReadySteps,
  createDefaultExecutionOptions,
} from './index.js';
import type { AgentPlanStep } from './plan.js';
import type { EditorContext } from './context.js';

function createMockContext(overrides?: Partial<EditorContext>): EditorContext {
  return {
    project: {
      id: 'test-project',
      name: 'Test Project',
      durationUs: 60_000_000,
      compositionCount: 1,
      trackCount: 2,
      clipCount: 2,
      hasCaptions: false,
      hasAudio: true,
      missingAssets: [],
    },
    selection: {
      selectedClipIds: [],
      selectedTrackIds: [],
      playheadUs: 0,
    },
    timeline: {
      compositions: [],
      totalDurationUs: 60_000_000,
    },
    audio: {
      clipCount: 0,
      busCount: 0,
      hasDialogue: false,
    },
    providers: {
      availableProviders: [],
      localOnly: true,
    },
    availableTools: ['insertClip', 'removeClip', 'moveClip', 'setGain'],
    recentHistory: [],
    constraints: [],
    ...overrides,
  };
}

function createTestStep(overrides?: Partial<AgentPlanStep>): AgentPlanStep {
  return {
    id: 'step-1',
    description: 'Test step',
    mode: 'command',
    tool: 'insertClip',
    arguments: {
      compositionId: 'comp-1',
      trackId: 'track-1',
      clip: { id: 'clip-new', kind: 'video', startUs: 10_000_000, durationUs: 1_000_000 },
    },
    dependsOn: [],
    expectedChange: 'Insert clip',
    preconditions: [],
    requiresConfirmation: false,
    ...overrides,
  };
}

describe('Execution Order Resolution', () => {
  it('resolves linear dependencies correctly', () => {
    const steps = [
      createTestStep({ id: 'step-1' }),
      createTestStep({ id: 'step-2', dependsOn: ['step-1'] }),
      createTestStep({ id: 'step-3', dependsOn: ['step-2'] }),
    ];
    const plan = createPlan('Test goal', steps);
    const order = resolveExecutionOrder(plan);

    expect(order.hasCycle).toBe(false);
    expect(order.order).toEqual(['step-1', 'step-2', 'step-3']);
  });

  it('groups parallel steps correctly', () => {
    const steps = [
      createTestStep({ id: 'step-1' }),
      createTestStep({ id: 'step-2' }),
      createTestStep({ id: 'step-3', dependsOn: ['step-1', 'step-2'] }),
    ];
    const plan = createPlan('Test goal', steps);
    const order = resolveExecutionOrder(plan);

    expect(order.hasCycle).toBe(false);
    expect(order.parallel).toHaveLength(2);
    expect(order.parallel[0]).toContain('step-1');
    expect(order.parallel[0]).toContain('step-2');
    expect(order.parallel[1]).toContain('step-3');
  });

  it('detects cycles', () => {
    const steps = [
      createTestStep({ id: 'step-1', dependsOn: ['step-2'] }),
      createTestStep({ id: 'step-2', dependsOn: ['step-1'] }),
    ];
    const plan = createPlan('Test goal', steps);
    const order = resolveExecutionOrder(plan);

    expect(order.hasCycle).toBe(true);
  });

  it('handles diamond dependencies', () => {
    const steps = [
      createTestStep({ id: 'step-1' }),
      createTestStep({ id: 'step-2', dependsOn: ['step-1'] }),
      createTestStep({ id: 'step-3', dependsOn: ['step-1'] }),
      createTestStep({ id: 'step-4', dependsOn: ['step-2', 'step-3'] }),
    ];
    const plan = createPlan('Test goal', steps);
    const order = resolveExecutionOrder(plan);

    expect(order.hasCycle).toBe(false);
    expect(order.order[0]).toBe('step-1');
    expect(order.order[3]).toBe('step-4');
  });
});

describe('canStepExecute', () => {
  it('returns true when all dependencies are completed', () => {
    const step = createTestStep({ id: 'step-2', dependsOn: ['step-1'] });
    const completed = new Set(['step-1']);
    expect(canStepExecute(step, completed)).toBe(true);
  });

  it('returns false when dependencies are not completed', () => {
    const step = createTestStep({ id: 'step-2', dependsOn: ['step-1'] });
    const completed = new Set<string>();
    expect(canStepExecute(step, completed)).toBe(false);
  });

  it('returns true for steps with no dependencies', () => {
    const step = createTestStep({ id: 'step-1', dependsOn: [] });
    const completed = new Set<string>();
    expect(canStepExecute(step, completed)).toBe(true);
  });
});

describe('getReadySteps', () => {
  it('returns steps that are ready to execute', () => {
    const steps = [
      createTestStep({ id: 'step-1' }),
      createTestStep({ id: 'step-2', dependsOn: ['step-1'] }),
      createTestStep({ id: 'step-3' }),
    ];
    const plan = createPlan('Test goal', steps);
    const completed = new Set<string>();
    const started = new Set<string>();

    const ready = getReadySteps(plan, completed, started);
    expect(ready).toHaveLength(2);
    expect(ready.map((s) => s.id)).toContain('step-1');
    expect(ready.map((s) => s.id)).toContain('step-3');
  });

  it('excludes completed and started steps', () => {
    const steps = [createTestStep({ id: 'step-1' }), createTestStep({ id: 'step-2' })];
    const plan = createPlan('Test goal', steps);
    const completed = new Set(['step-1']);
    const started = new Set(['step-2']);

    const ready = getReadySteps(plan, completed, started);
    expect(ready).toHaveLength(0);
  });
});

describe('Idempotency Store', () => {
  it('tracks executions', () => {
    const store = createIdempotencyStore();
    const key = store.generateKey('plan-1', 'step-1', 0);

    expect(store.hasExecuted(key)).toBe(false);

    store.recordExecution(key, 'plan-1', 'step-1', { success: true });
    expect(store.hasExecuted(key)).toBe(true);
  });

  it('prevents duplicate execution', () => {
    const store = createIdempotencyStore();
    const key = store.generateKey('plan-1', 'step-1', 0);

    store.recordExecution(key, 'plan-1', 'step-1', { success: true });
    const record = store.getRecord(key);

    expect(record).toBeDefined();
    expect(record?.status).toBe('completed');
    expect(record?.result?.success).toBe(true);
  });

  it('records failures', () => {
    const store = createIdempotencyStore();
    const key = store.generateKey('plan-1', 'step-1', 0);

    store.recordFailure(key, 'plan-1', 'step-1', 'Test error');
    const record = store.getRecord(key);

    expect(record).toBeDefined();
    expect(record?.status).toBe('failed');
    expect(record?.result?.success).toBe(false);
    expect(record?.result?.error).toBe('Test error');
  });

  it('gets records for plan', () => {
    const store = createIdempotencyStore();
    const key1 = store.generateKey('plan-1', 'step-1', 0);
    const key2 = store.generateKey('plan-1', 'step-2', 0);
    const key3 = store.generateKey('plan-2', 'step-1', 0);

    store.recordExecution(key1, 'plan-1', 'step-1', { success: true });
    store.recordExecution(key2, 'plan-1', 'step-2', { success: true });
    store.recordExecution(key3, 'plan-2', 'step-1', { success: true });

    const plan1Records = store.getRecordsForPlan('plan-1');
    expect(plan1Records).toHaveLength(2);
  });

  it('clears all records', () => {
    const store = createIdempotencyStore();
    const key = store.generateKey('plan-1', 'step-1', 0);

    store.recordExecution(key, 'plan-1', 'step-1', { success: true });
    expect(store.hasExecuted(key)).toBe(true);

    store.clear();
    expect(store.hasExecuted(key)).toBe(false);
  });
});

describe('Transaction Naming', () => {
  it('generates human-readable labels', () => {
    const steps = [createTestStep()];
    const plan = createPlan('Insert a new clip', steps);
    const label = generateTransactionLabel(plan);

    expect(label).toContain('Insert a new clip');
    expect(label).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\]/);
  });

  it('generates step labels', () => {
    const step = createTestStep({ description: 'Insert clip into track' });
    const label = generateStepLabel(step);

    expect(label).toContain('insertClip');
    expect(label).toContain('Insert clip into track');
  });

  it('formats transaction labels with timestamp', () => {
    const label = formatTransactionLabel('Test operation', '2024-01-15T10-30-00');
    expect(label).toBe('[2024-01-15T10-30-00] Test operation');
  });
});

describe('Dry-Run Simulation', () => {
  it('simulates all steps without applying changes', () => {
    const steps = [
      createTestStep({
        id: 'step-1',
        tool: 'insertClip',
        arguments: {
          compositionId: 'comp-1',
          trackId: 'track-1',
          clip: { id: 'clip-new' },
        },
      }),
    ];
    const plan = createPlan('Test goal', steps);
    const registry = createToolRegistry();
    const context = createMockContext();

    const result = dryRunPlan(plan, registry, context);

    expect(result.success).toBe(true);
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0]?.success).toBe(true);
    expect(result.stepResults[0]?.diff?.created).toContain('clip-new');
  });

  it('checks preconditions for each step', () => {
    const steps = [
      createTestStep({
        id: 'step-1',
        preconditions: [{ type: 'entity-exists', message: 'Entity must exist' }],
      }),
    ];
    const plan = createPlan('Test goal', steps);
    const registry = createToolRegistry();
    const context = createMockContext();

    const result = dryRunPlan(plan, registry, context);

    expect(result.success).toBe(false);
    expect(result.stepResults[0]?.preconditionsMet).toBe(false);
    expect(result.stepResults[0]?.failedPreconditions).toHaveLength(1);
  });

  it('aggregates diffs correctly', () => {
    const steps = [
      createTestStep({
        id: 'step-1',
        tool: 'insertClip',
        arguments: {
          compositionId: 'comp-1',
          trackId: 'track-1',
          clip: { id: 'clip-1' },
        },
      }),
      createTestStep({
        id: 'step-2',
        tool: 'insertClip',
        arguments: {
          compositionId: 'comp-1',
          trackId: 'track-1',
          clip: { id: 'clip-2' },
        },
      }),
    ];
    const plan = createPlan('Test goal', steps);
    const registry = createToolRegistry();
    const context = createMockContext();

    const result = dryRunPlan(plan, registry, context);

    expect(result.aggregateDiff.clipsCreated).toBe(2);
    expect(result.aggregateDiff.summary).toContain('2 clip(s) created');
  });

  it('handles step failures gracefully', () => {
    const steps = [
      createTestStep({
        id: 'step-1',
        tool: 'nonexistentTool',
      }),
      createTestStep({
        id: 'step-2',
        tool: 'insertClip',
        arguments: {
          compositionId: 'comp-1',
          trackId: 'track-1',
          clip: { id: 'clip-2' },
        },
      }),
    ];
    const plan = createPlan('Test goal', steps);
    const registry = createToolRegistry();
    const context = createMockContext();

    const result = dryRunPlan(plan, registry, context);

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.stepResults).toHaveLength(2);
  });

  it('detects circular dependencies', () => {
    const steps = [
      createTestStep({ id: 'step-1', dependsOn: ['step-2'] }),
      createTestStep({ id: 'step-2', dependsOn: ['step-1'] }),
    ];
    const plan = createPlan('Test goal', steps);
    const registry = createToolRegistry();
    const context = createMockContext();

    const result = dryRunPlan(plan, registry, context);

    expect(result.success).toBe(false);
    expect(result.errors).toContain('Plan contains circular dependencies');
  });
});

describe('Plan Executor', () => {
  let registry: ReturnType<typeof createToolRegistry>;
  let approvalEngine: ApprovalEngine;
  let context: EditorContext;

  beforeEach(() => {
    registry = createToolRegistry();
    approvalEngine = new ApprovalEngine(createPermissiveApprovalPolicy());
    context = createMockContext();
  });

  it('executes steps in correct dependency order', async () => {
    const steps = [
      createTestStep({
        id: 'step-1',
        tool: 'insertClip',
        arguments: {
          compositionId: 'comp-1',
          trackId: 'track-1',
          clip: { id: 'clip-1' },
        },
      }),
      createTestStep({
        id: 'step-2',
        tool: 'moveClip',
        arguments: { clipId: 'clip-1', newStartUs: 20_000_000 },
        dependsOn: ['step-1'],
      }),
    ];
    const plan = createPlan('Test goal', steps);
    const executor = new PlanExecutor(registry, approvalEngine);

    const result = await executor.execute(plan, context, {});

    expect(result.success).toBe(true);
    expect(result.stepResults).toHaveLength(2);
    expect(result.stepResults[0]?.stepId).toBe('step-1');
    expect(result.stepResults[1]?.stepId).toBe('step-2');
  });

  it('re-checks preconditions before each step', async () => {
    const steps = [
      createTestStep({
        id: 'step-1',
        preconditions: [{ type: 'entity-exists', message: 'Entity must exist' }],
      }),
    ];
    const plan = createPlan('Test goal', steps);
    const executor = new PlanExecutor(registry, approvalEngine);

    const result = await executor.execute(plan, context, {});

    expect(result.success).toBe(false);
    expect(result.stepResults[0]?.status).toBe('failed');
  });

  it('uses idempotency keys', async () => {
    const steps = [
      createTestStep({
        id: 'step-1',
        tool: 'insertClip',
        arguments: {
          compositionId: 'comp-1',
          trackId: 'track-1',
          clip: { id: 'clip-1' },
        },
      }),
    ];
    const plan = createPlan('Test goal', steps);
    const executor = new PlanExecutor(registry, approvalEngine);

    const result = await executor.execute(plan, context, {});

    expect(result.stepResults[0]?.idempotencyKey).toBeDefined();
  });

  it('generates transaction labels', async () => {
    const steps = [createTestStep()];
    const plan = createPlan('Insert a clip', steps);
    const executor = new PlanExecutor(registry, approvalEngine);

    const result = await executor.execute(plan, context, {});

    expect(result.transactionLabel).toContain('Insert a clip');
  });

  it('stops on policy failure when configured', async () => {
    const strictEngine = new ApprovalEngine(createDefaultApprovalPolicy());
    const steps = [
      createTestStep({
        id: 'step-1',
        tool: 'voiceClone',
        requiresConfirmation: false,
      }),
      createTestStep({
        id: 'step-2',
        tool: 'insertClip',
        arguments: {
          compositionId: 'comp-1',
          trackId: 'track-1',
          clip: { id: 'clip-1' },
        },
      }),
    ];
    const plan = createPlan('Test goal', steps);
    const executor = new PlanExecutor(registry, strictEngine, {
      stopOnPolicyFailure: true,
    });

    const result = await executor.execute(plan, context, {});

    expect(result.stepResults[0]?.status).toBe('blocked-by-policy');
    expect(result.stepResults).toHaveLength(1);
  });

  it('allows independent steps to continue when configured', async () => {
    const strictEngine = new ApprovalEngine(createDefaultApprovalPolicy());
    const steps = [
      createTestStep({
        id: 'step-1',
        tool: 'voiceClone',
        requiresConfirmation: false,
      }),
      createTestStep({
        id: 'step-2',
        tool: 'insertClip',
        arguments: {
          compositionId: 'comp-1',
          trackId: 'track-1',
          clip: { id: 'clip-1' },
        },
      }),
    ];
    const plan = createPlan('Test goal', steps);
    const executor = new PlanExecutor(registry, strictEngine, {
      stopOnPolicyFailure: false,
      manualApprovalGranted: true,
    });

    const result = await executor.execute(plan, context, {});

    expect(result.stepResults).toHaveLength(2);
    expect(result.stepResults[0]?.status).toBe('blocked-by-policy');
    expect(result.stepResults[1]?.status).toBe('success');
  });

  it('stops on step failure when configured', async () => {
    const steps = [
      createTestStep({
        id: 'step-1',
        tool: 'nonexistentTool',
      }),
      createTestStep({
        id: 'step-2',
        tool: 'insertClip',
        arguments: {
          compositionId: 'comp-1',
          trackId: 'track-1',
          clip: { id: 'clip-1' },
        },
      }),
    ];
    const plan = createPlan('Test goal', steps);
    const executor = new PlanExecutor(registry, approvalEngine, {
      stopOnFailure: true,
    });

    const result = await executor.execute(plan, context, {});

    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0]?.status).toBe('failed');
  });

  it('tracks rollback availability', async () => {
    const steps = [
      createTestStep({
        id: 'step-1',
        tool: 'insertClip',
        arguments: {
          compositionId: 'comp-1',
          trackId: 'track-1',
          clip: { id: 'clip-1' },
        },
      }),
    ];
    const plan = createPlan('Test goal', steps);
    const executor = new PlanExecutor(registry, approvalEngine);

    const result = await executor.execute(plan, context, {});

    expect(result.rollbackAvailable).toBe(true);
  });

  it('aggregates diffs from execution', async () => {
    const steps = [
      createTestStep({
        id: 'step-1',
        tool: 'insertClip',
        arguments: {
          compositionId: 'comp-1',
          trackId: 'track-1',
          clip: { id: 'clip-1' },
        },
      }),
      createTestStep({
        id: 'step-2',
        tool: 'insertClip',
        arguments: {
          compositionId: 'comp-1',
          trackId: 'track-1',
          clip: { id: 'clip-2' },
        },
      }),
    ];
    const plan = createPlan('Test goal', steps);
    const executor = new PlanExecutor(registry, approvalEngine);

    const result = await executor.execute(plan, context, {});

    expect(result.aggregateDiff.clipsCreated).toBe(2);
  });

  it('executes single step with idempotency', async () => {
    const step = createTestStep({
      id: 'step-1',
      tool: 'insertClip',
      arguments: {
        compositionId: 'comp-1',
        trackId: 'track-1',
        clip: { id: 'clip-1' },
      },
    });
    const executor = new PlanExecutor(registry, approvalEngine);
    const idempotencyKey = 'test-key-1';

    const result = await executor.executeStep(step, context, {}, idempotencyKey);

    expect(result.status).toBe('success');
    expect(result.idempotencyKey).toBe(idempotencyKey);
  });

  it('handles circular dependencies', async () => {
    const steps = [
      createTestStep({ id: 'step-1', dependsOn: ['step-2'] }),
      createTestStep({ id: 'step-2', dependsOn: ['step-1'] }),
    ];
    const plan = createPlan('Test goal', steps);
    const executor = new PlanExecutor(registry, approvalEngine);

    const result = await executor.execute(plan, context, {});

    expect(result.success).toBe(false);
    expect(result.errors).toContain('Plan contains circular dependencies');
  });
});

describe('Default Execution Options', () => {
  it('creates sensible defaults', () => {
    const options = createDefaultExecutionOptions();

    expect(options.stopOnFailure).toBe(true);
    expect(options.stopOnPolicyFailure).toBe(true);
    expect(options.allowIndependentContinue).toBe(false);
    expect(options.idempotencyPrefix).toBe('exec');
    expect(options.manualApprovalGranted).toBe(false);
  });
});
