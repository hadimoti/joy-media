import type { EditorContext } from './context.js';
import type { ToolRegistry } from './registry.js';
import type { AgentEditPlan, AgentPlanStep, PrivacyImpact } from './plan.js';
import type { CostEstimate, Precondition, ToolDiff } from './types.js';
import type { EditTool } from './edit-tools.js';
import { resolveExecutionOrder } from './execution-order.js';
import { estimateStep } from './estimation.js';

export interface DryRunResult {
  readonly planId: string;
  readonly success: boolean;
  readonly stepResults: readonly DryRunStepResult[];
  readonly aggregateDiff: AggregateDiff;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly estimatedCost?: CostEstimate;
  readonly privacyImpacts: readonly PrivacyImpact[];
}

export interface DryRunStepResult {
  readonly stepId: string;
  readonly success: boolean;
  readonly diff?: ToolDiff;
  readonly preconditionsMet: boolean;
  readonly failedPreconditions?: readonly Precondition[];
  readonly warnings: readonly string[];
}

export interface AggregateDiff {
  readonly clipsCreated: number;
  readonly clipsModified: number;
  readonly clipsDeleted: number;
  readonly tracksAffected: readonly string[];
  readonly timeRangesAffected: readonly { startUs: number; endUs: number }[];
  readonly effectsAdded: number;
  readonly captionsAdded: number;
  readonly jobsRequired: number;
  readonly summary: string;
}

/** Mutable while accumulating; only ever exposed as the readonly `AggregateDiff` shape above. */
type MutableAggregateDiff = {
  clipsCreated: number;
  clipsModified: number;
  clipsDeleted: number;
  tracksAffected: string[];
  timeRangesAffected: { startUs: number; endUs: number }[];
  effectsAdded: number;
  captionsAdded: number;
  jobsRequired: number;
  summary: string;
};

export function dryRunPlan(
  plan: AgentEditPlan,
  registry: ToolRegistry,
  context: EditorContext,
): DryRunResult {
  const executionOrder = resolveExecutionOrder(plan);

  if (executionOrder.hasCycle) {
    return {
      planId: plan.planId,
      success: false,
      stepResults: [],
      aggregateDiff: createEmptyAggregateDiff(),
      warnings: [],
      errors: ['Plan contains circular dependencies'],
      privacyImpacts: [],
    };
  }

  const stepResults: DryRunStepResult[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const privacyImpacts: PrivacyImpact[] = [];
  const aggregateDiff = createEmptyAggregateDiff();

  let totalWorkerTimeMs = 0;
  let totalCostAmount = 0;
  let currency = 'USD';

  for (const stepId of executionOrder.order) {
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) {
      errors.push(`Step ${stepId} not found`);
      continue;
    }

    const tool = registry.getTool(step.tool);
    if (!tool) {
      errors.push(`Tool ${step.tool} not found for step ${stepId}`);
      stepResults.push({
        stepId,
        success: false,
        preconditionsMet: false,
        failedPreconditions: [],
        warnings: [`Tool ${step.tool} not found`],
      });
      continue;
    }

    const failedPreconditions = checkPreconditions(step, context);
    const preconditionsMet = failedPreconditions.length === 0;

    if (!preconditionsMet) {
      warnings.push(`Step ${stepId} preconditions not met`);
      stepResults.push({
        stepId,
        success: false,
        preconditionsMet: false,
        failedPreconditions,
        warnings: failedPreconditions.map((p) => p.message),
      });
      continue;
    }

    if ('dryRun' in tool && typeof tool.dryRun === 'function') {
      const editTool = tool as EditTool;
      const diff = editTool.dryRun(context, step.arguments);

      stepResults.push({
        stepId,
        success: true,
        diff,
        preconditionsMet: true,
        warnings: [],
      });

      aggregateDiffs(aggregateDiff, diff, step);
    } else {
      stepResults.push({
        stepId,
        success: true,
        preconditionsMet: true,
        warnings: ['Tool does not support dry-run'],
      });
    }

    const estimation = estimateStep(step, registry, context);
    if (estimation.cost?.workerTimeMs) {
      totalWorkerTimeMs += estimation.cost.workerTimeMs;
    }
    if (estimation.cost?.providerCost) {
      totalCostAmount += parseFloat(estimation.cost.providerCost.amount);
      currency = estimation.cost.providerCost.currency;
    }
    if (estimation.privacy) {
      privacyImpacts.push(estimation.privacy);
    }
  }

  const success = errors.length === 0 && stepResults.every((r) => r.success);

  const estimatedCost: CostEstimate | undefined =
    totalWorkerTimeMs > 0 || totalCostAmount > 0
      ? {
          workerTimeMs: totalWorkerTimeMs,
          ...(totalCostAmount > 0 && {
            providerCost: { amount: totalCostAmount.toFixed(2), currency },
          }),
          localOnly: privacyImpacts.every((p) => !p.dataLeavesDevice),
        }
      : undefined;

  return {
    planId: plan.planId,
    success,
    stepResults,
    aggregateDiff: {
      ...aggregateDiff,
      summary: generateAggregateSummary(aggregateDiff),
    },
    warnings,
    errors,
    ...(estimatedCost !== undefined && { estimatedCost }),
    privacyImpacts,
  };
}

function checkPreconditions(step: AgentPlanStep, context: EditorContext): readonly Precondition[] {
  const failed: Precondition[] = [];

  for (const precondition of step.preconditions) {
    if (!evaluatePrecondition(precondition, context)) {
      failed.push(precondition);
    }
  }

  return failed;
}

function evaluatePrecondition(precondition: Precondition, context: EditorContext): boolean {
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

function aggregateDiffs(
  aggregate: MutableAggregateDiff,
  diff: ToolDiff,
  step: AgentPlanStep,
): void {
  aggregate.clipsCreated += diff.created.length;
  aggregate.clipsModified += diff.modified.length;
  aggregate.clipsDeleted += diff.deleted.length;

  if (step.mode === 'job') {
    aggregate.jobsRequired += 1;
  }

  const toolName = step.tool.toLowerCase();
  if (toolName.includes('effect')) {
    aggregate.effectsAdded += diff.created.length;
  }
  if (toolName.includes('caption')) {
    aggregate.captionsAdded += diff.created.length;
  }
}

function createEmptyAggregateDiff(): MutableAggregateDiff {
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
