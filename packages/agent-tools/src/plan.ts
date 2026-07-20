import type { CostEstimate, JsonValue, Precondition } from './types.js';

export interface AgentEditPlan {
  readonly planVersion: 1;
  readonly planId: string;
  readonly goal: string;
  readonly assumptions: readonly string[];
  readonly steps: readonly AgentPlanStep[];
  readonly estimated: PlanEstimate;
  readonly risks: readonly string[];
  readonly requiredApprovals: readonly ApprovalRequest[];
  readonly createdAt: string;
  readonly status: PlanStatus;
}

export interface AgentPlanStep {
  readonly id: string;
  readonly description: string;
  readonly mode: 'command' | 'job' | 'analysis' | 'decision';
  readonly tool: string;
  readonly arguments: JsonValue;
  readonly dependsOn: readonly string[];
  readonly expectedChange: string;
  readonly preconditions: readonly Precondition[];
  readonly estimatedCost?: CostEstimate;
  readonly requiresConfirmation: boolean;
}

export interface PlanEstimate {
  readonly commandCount: number;
  readonly generationJobs: number;
  readonly cost?: MoneyRange;
  readonly workerTimeMs?: DurationRange;
  readonly confidence: 'low' | 'medium' | 'high';
}

export interface MoneyRange {
  readonly min: Money;
  readonly max: Money;
}

export interface DurationRange {
  readonly minMs: number;
  readonly maxMs: number;
}

export interface Money {
  readonly amount: string;
  readonly currency: string;
}

export type PlanStatus =
  'draft' | 'pending-approval' | 'approved' | 'executing' | 'completed' | 'failed' | 'cancelled';

export interface ApprovalRequest {
  readonly id: string;
  readonly stepId: string;
  readonly reason: ApprovalReason;
  readonly description: string;
  readonly estimatedCost?: Money;
  readonly privacyImpact: PrivacyImpact;
  readonly isReversible: boolean;
  readonly status: 'pending' | 'approved' | 'rejected';
}

export type ApprovalReason =
  | 'paid-generation'
  | 'remote-upload'
  | 'voice-cloning'
  | 'destructive-edit'
  | 'publish-export'
  | 'plugin-install'
  | 'project-settings-change'
  | 'unresolved-assumptions'
  | 'overwrite-output';

export interface PrivacyImpact {
  readonly dataLeavesDevice: boolean;
  readonly providerId?: string;
  readonly dataTypes: readonly string[];
  readonly retentionDisclosure?: string;
}

export interface PlanOptions {
  readonly planId?: string;
  readonly assumptions?: readonly string[];
  readonly risks?: readonly string[];
  readonly requiredApprovals?: readonly ApprovalRequest[];
  readonly createdAt?: string;
  readonly status?: PlanStatus;
}

let planCounter = 0;

export function createPlan(
  goal: string,
  steps: AgentPlanStep[],
  options?: PlanOptions,
): AgentEditPlan {
  const planId = options?.planId ?? `plan-${++planCounter}-${Date.now()}`;
  const createdAt = options?.createdAt ?? new Date().toISOString();
  const status = options?.status ?? 'draft';
  const assumptions = options?.assumptions ?? [];
  const risks = options?.risks ?? [];
  const requiredApprovals = options?.requiredApprovals ?? [];

  const estimated = computeEstimate(steps);

  return {
    planVersion: 1,
    planId,
    goal,
    assumptions,
    steps,
    estimated,
    risks,
    requiredApprovals,
    createdAt,
    status,
  };
}

export function validatePlan(plan: AgentEditPlan): { valid: boolean; errors: readonly string[] } {
  const errors: string[] = [];

  if (plan.planVersion !== 1) {
    errors.push('planVersion must be 1');
  }

  if (!plan.planId || plan.planId.trim().length === 0) {
    errors.push('planId is required');
  }

  if (!plan.goal || plan.goal.trim().length === 0) {
    errors.push('goal is required');
  }

  if (plan.steps.length === 0) {
    errors.push('plan must have at least one step');
  }

  const stepIds = new Set<string>();
  for (const step of plan.steps) {
    if (stepIds.has(step.id)) {
      errors.push(`duplicate step id: ${step.id}`);
    }
    stepIds.add(step.id);
  }

  const validStatuses: readonly PlanStatus[] = [
    'draft',
    'pending-approval',
    'approved',
    'executing',
    'completed',
    'failed',
    'cancelled',
  ];
  if (!validStatuses.includes(plan.status)) {
    errors.push(`invalid status: ${plan.status}`);
  }

  return { valid: errors.length === 0, errors };
}

export function addStepToPlan(plan: AgentEditPlan, step: AgentPlanStep): AgentEditPlan {
  const newSteps = [...plan.steps, step];
  const estimated = computeEstimate(newSteps);
  return { ...plan, steps: newSteps, estimated };
}

export function updatePlanStatus(plan: AgentEditPlan, status: PlanStatus): AgentEditPlan {
  return { ...plan, status };
}

function computeEstimate(steps: readonly AgentPlanStep[]): PlanEstimate {
  let commandCount = 0;
  let generationJobs = 0;
  let totalMinMs = 0;
  let totalMaxMs = 0;
  let hasCost = false;
  let minCostAmount = 0;
  let maxCostAmount = 0;
  let currency = 'USD';
  let allHaveEstimates = true;

  for (const step of steps) {
    if (step.mode === 'command') {
      commandCount++;
    } else if (step.mode === 'job') {
      generationJobs++;
    }

    if (step.estimatedCost) {
      hasCost = true;
      if (step.estimatedCost.workerTimeMs !== undefined) {
        totalMinMs += step.estimatedCost.workerTimeMs;
        totalMaxMs += step.estimatedCost.workerTimeMs;
      }
      if (step.estimatedCost.providerCost) {
        const amount = parseFloat(step.estimatedCost.providerCost.amount);
        if (!isNaN(amount)) {
          minCostAmount += amount;
          maxCostAmount += amount;
          currency = step.estimatedCost.providerCost.currency;
        }
      }
    } else {
      allHaveEstimates = false;
    }
  }

  const confidence: 'low' | 'medium' | 'high' =
    steps.length === 0 ? 'low' : allHaveEstimates ? 'high' : steps.length <= 3 ? 'medium' : 'low';

  const base: {
    commandCount: number;
    generationJobs: number;
    confidence: 'low' | 'medium' | 'high';
    cost?: MoneyRange;
    workerTimeMs?: DurationRange;
  } = {
    commandCount,
    generationJobs,
    confidence,
  };

  if (hasCost) {
    base.cost = {
      min: { amount: minCostAmount.toFixed(2), currency },
      max: { amount: maxCostAmount.toFixed(2), currency },
    };
  }

  if (totalMinMs > 0 || totalMaxMs > 0) {
    base.workerTimeMs = { minMs: totalMinMs, maxMs: totalMaxMs };
  }

  return base;
}
