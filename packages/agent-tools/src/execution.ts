import type { EditorContext } from './context.js';
import type { ToolRegistry } from './registry.js';
import type { ApprovalEngine } from './approval.js';
import type { AgentEditPlan, AgentPlanStep } from './plan.js';
import type { CostEstimate, Precondition, ToolResult } from './types.js';
import type { EditTool } from './edit-tools.js';
import { resolveExecutionOrder } from './execution-order.js';
import type { IdempotencyStore } from './idempotency.js';
import { createIdempotencyStore } from './idempotency.js';
import { generateTransactionLabel } from './transaction-naming.js';
import type { AggregateDiff } from './dry-run.js';

export interface ExecutionResult {
  readonly planId: string;
  readonly success: boolean;
  readonly transactionLabel: string;
  readonly stepResults: readonly ExecutionStepResult[];
  readonly aggregateDiff: AggregateDiff;
  readonly actualCost?: CostEstimate;
  readonly durationMs: number;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly rollbackAvailable: boolean;
}

export interface ExecutionStepResult {
  readonly stepId: string;
  readonly status: 'success' | 'failed' | 'skipped' | 'blocked-by-policy';
  readonly toolResult?: ToolResult;
  readonly error?: string;
  readonly durationMs: number;
  readonly idempotencyKey?: string;
}

export interface ExecutionOptions {
  readonly stopOnFailure: boolean;
  readonly stopOnPolicyFailure: boolean;
  readonly allowIndependentContinue: boolean;
  readonly idempotencyPrefix: string;
  readonly transactionLabel: string;
}

export function createDefaultExecutionOptions(): ExecutionOptions {
  return {
    stopOnFailure: true,
    stopOnPolicyFailure: true,
    allowIndependentContinue: false,
    idempotencyPrefix: 'exec',
    transactionLabel: '',
  };
}

export class PlanExecutor {
  private readonly registry: ToolRegistry;
  private readonly approvalEngine: ApprovalEngine;
  private readonly options: ExecutionOptions;
  private readonly idempotencyStore: IdempotencyStore;

  constructor(
    registry: ToolRegistry,
    approvalEngine: ApprovalEngine,
    options?: Partial<ExecutionOptions>,
  ) {
    this.registry = registry;
    this.approvalEngine = approvalEngine;
    this.options = { ...createDefaultExecutionOptions(), ...options };
    this.idempotencyStore = createIdempotencyStore();
  }

  async execute(
    plan: AgentEditPlan,
    context: EditorContext,
    _projectState: unknown,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const transactionLabel = this.options.transactionLabel || generateTransactionLabel(plan);

    const executionOrder = resolveExecutionOrder(plan);
    if (executionOrder.hasCycle) {
      return {
        planId: plan.planId,
        success: false,
        transactionLabel,
        stepResults: [],
        aggregateDiff: createEmptyAggregateDiff(),
        durationMs: Date.now() - startTime,
        errors: ['Plan contains circular dependencies'],
        warnings: [],
        rollbackAvailable: false,
      };
    }

    const stepResults: ExecutionStepResult[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const completedSteps = new Set<string>();
    const aggregateDiff = createEmptyAggregateDiff();

    let totalWorkerTimeMs = 0;
    let totalCostAmount = 0;
    let currency = 'USD';
    let allReversible = true;

    for (const stepId of executionOrder.order) {
      const step = plan.steps.find((s) => s.id === stepId);
      if (!step) {
        errors.push(`Step ${stepId} not found`);
        continue;
      }

      const stepStartTime = Date.now();

      const approvalDecision = this.approvalEngine.evaluateStep(step, context);
      if (approvalDecision.decision === 'blocked') {
        const result: ExecutionStepResult = {
          stepId,
          status: 'blocked-by-policy',
          error: approvalDecision.reason,
          durationMs: Date.now() - stepStartTime,
        };
        stepResults.push(result);
        errors.push(`Step ${stepId} blocked: ${approvalDecision.reason}`);

        if (this.options.stopOnPolicyFailure) {
          break;
        }
        continue;
      }

      const failedPreconditions = this.checkPreconditions(step, context);
      if (failedPreconditions.length > 0) {
        const result: ExecutionStepResult = {
          stepId,
          status: 'failed',
          error: failedPreconditions.map((p) => p.message).join(', '),
          durationMs: Date.now() - stepStartTime,
        };
        stepResults.push(result);
        errors.push(`Step ${stepId} preconditions failed`);

        if (this.options.stopOnFailure) {
          break;
        }
        continue;
      }

      const idempotencyKey = this.idempotencyStore.generateKey(plan.planId, stepId, 0);

      if (this.idempotencyStore.hasExecuted(idempotencyKey)) {
        const record = this.idempotencyStore.getRecord(idempotencyKey);
        const result: ExecutionStepResult = {
          stepId,
          status: 'success',
          toolResult: record?.result,
          durationMs: 0,
          idempotencyKey,
        };
        stepResults.push(result);
        completedSteps.add(stepId);
        continue;
      }

      const tool = this.registry.getTool(step.tool);
      if (!tool) {
        const result: ExecutionStepResult = {
          stepId,
          status: 'failed',
          error: `Tool ${step.tool} not found`,
          durationMs: Date.now() - stepStartTime,
          idempotencyKey,
        };
        stepResults.push(result);
        this.idempotencyStore.recordFailure(
          idempotencyKey,
          plan.planId,
          stepId,
          `Tool ${step.tool} not found`,
        );
        errors.push(`Step ${stepId} tool not found`);

        if (this.options.stopOnFailure) {
          break;
        }
        continue;
      }

      let toolResult: ToolResult;
      if ('execute' in tool) {
        if ('dryRun' in tool) {
          const editTool = tool as EditTool;
          toolResult = editTool.execute(context, step.arguments);
        } else {
          toolResult = tool.execute(context, step.arguments);
        }
      } else {
        toolResult = { success: false, error: 'Tool does not support execution' };
      }

      const stepDuration = Date.now() - stepStartTime;

      if (toolResult.success) {
        this.idempotencyStore.recordExecution(idempotencyKey, plan.planId, stepId, toolResult);
        completedSteps.add(stepId);

        const toolDef = 'definition' in tool ? tool.definition : null;
        if (toolDef?.scope.isReversible === false) {
          allReversible = false;
        }

        if (toolResult.diff) {
          aggregateDiff.clipsCreated += toolResult.diff.created.length;
          aggregateDiff.clipsModified += toolResult.diff.modified.length;
          aggregateDiff.clipsDeleted += toolResult.diff.deleted.length;
        }

        if (step.estimatedCost?.workerTimeMs) {
          totalWorkerTimeMs += step.estimatedCost.workerTimeMs;
        }
        if (step.estimatedCost?.providerCost) {
          totalCostAmount += parseFloat(step.estimatedCost.providerCost.amount);
          currency = step.estimatedCost.providerCost.currency;
        }
      } else {
        this.idempotencyStore.recordFailure(
          idempotencyKey,
          plan.planId,
          stepId,
          toolResult.error ?? 'Unknown error',
        );
        errors.push(`Step ${stepId} failed: ${toolResult.error}`);
      }

      const result: ExecutionStepResult = {
        stepId,
        status: toolResult.success ? 'success' : 'failed',
        toolResult,
        durationMs: stepDuration,
        idempotencyKey,
      };
      stepResults.push(result);

      if (!toolResult.success && this.options.stopOnFailure) {
        break;
      }
    }

    const success = errors.length === 0;
    const durationMs = Date.now() - startTime;

    const actualCost: CostEstimate | undefined =
      totalWorkerTimeMs > 0 || totalCostAmount > 0
        ? {
            workerTimeMs: totalWorkerTimeMs,
            providerCost:
              totalCostAmount > 0 ? { amount: totalCostAmount.toFixed(2), currency } : undefined,
            localOnly: true,
          }
        : undefined;

    return {
      planId: plan.planId,
      success,
      transactionLabel,
      stepResults,
      aggregateDiff: {
        ...aggregateDiff,
        summary: generateAggregateSummary(aggregateDiff),
      },
      actualCost,
      durationMs,
      errors,
      warnings,
      rollbackAvailable: allReversible,
    };
  }

  async executeStep(
    step: AgentPlanStep,
    context: EditorContext,
    _projectState: unknown,
    idempotencyKey: string,
  ): Promise<ExecutionStepResult> {
    const startTime = Date.now();

    if (this.idempotencyStore.hasExecuted(idempotencyKey)) {
      const record = this.idempotencyStore.getRecord(idempotencyKey);
      return {
        stepId: step.id,
        status: 'success',
        toolResult: record?.result,
        durationMs: 0,
        idempotencyKey,
      };
    }

    const tool = this.registry.getTool(step.tool);
    if (!tool) {
      const error = `Tool ${step.tool} not found`;
      this.idempotencyStore.recordFailure(idempotencyKey, 'unknown', step.id, error);
      return {
        stepId: step.id,
        status: 'failed',
        error,
        durationMs: Date.now() - startTime,
        idempotencyKey,
      };
    }

    let toolResult: ToolResult;
    if ('execute' in tool) {
      if ('dryRun' in tool) {
        const editTool = tool as EditTool;
        toolResult = editTool.execute(context, step.arguments);
      } else {
        toolResult = tool.execute(context, step.arguments);
      }
    } else {
      toolResult = { success: false, error: 'Tool does not support execution' };
    }

    if (toolResult.success) {
      this.idempotencyStore.recordExecution(idempotencyKey, 'unknown', step.id, toolResult);
    } else {
      this.idempotencyStore.recordFailure(
        idempotencyKey,
        'unknown',
        step.id,
        toolResult.error ?? 'Unknown error',
      );
    }

    return {
      stepId: step.id,
      status: toolResult.success ? 'success' : 'failed',
      toolResult,
      durationMs: Date.now() - startTime,
      idempotencyKey,
    };
  }

  checkPreconditions(step: AgentPlanStep, context: EditorContext): readonly Precondition[] {
    const failed: Precondition[] = [];

    for (const precondition of step.preconditions) {
      if (!this.evaluatePrecondition(precondition, context)) {
        failed.push(precondition);
      }
    }

    return failed;
  }

  private evaluatePrecondition(precondition: Precondition, context: EditorContext): boolean {
    switch (precondition.type) {
      case 'entity-exists':
        return precondition.entityId !== undefined;
      case 'track-exists':
        return precondition.entityId !== undefined;
      case 'time-range-valid':
        return true;
      case 'provider-available':
        return context.providers.availableProviders.length > 0;
      case 'consent-active':
        return true;
      case 'no-overlap':
        return true;
      default:
        return true;
    }
  }
}

function createEmptyAggregateDiff(): AggregateDiff {
  return {
    clipsCreated: 0,
    clipsModified: 0,
    clipsDeleted: 0,
    tracksAffected: [],
    timeRangesAffected: [],
    effectsAdded: 0,
    captionsAdded: 0,
    jobsRequired: 0,
    summary: '',
  };
}

function generateAggregateSummary(aggregate: AggregateDiff): string {
  const parts: string[] = [];

  if (aggregate.clipsCreated > 0) {
    parts.push(`${aggregate.clipsCreated} clip(s) created`);
  }
  if (aggregate.clipsModified > 0) {
    parts.push(`${aggregate.clipsModified} clip(s) modified`);
  }
  if (aggregate.clipsDeleted > 0) {
    parts.push(`${aggregate.clipsDeleted} clip(s) deleted`);
  }
  if (aggregate.effectsAdded > 0) {
    parts.push(`${aggregate.effectsAdded} effect(s) added`);
  }
  if (aggregate.captionsAdded > 0) {
    parts.push(`${aggregate.captionsAdded} caption(s) added`);
  }
  if (aggregate.jobsRequired > 0) {
    parts.push(`${aggregate.jobsRequired} job(s) required`);
  }

  return parts.length > 0 ? parts.join(', ') : 'No changes';
}
