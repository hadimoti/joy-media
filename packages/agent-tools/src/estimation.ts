import type { ToolRegistry } from './registry.js';
import type { EditorContext } from './context.js';
import type {
  AgentEditPlan,
  AgentPlanStep,
  PrivacyImpact,
  Money,
  MoneyRange,
  DurationRange,
} from './plan.js';
import type { CostEstimate } from './types.js';

export interface PlanEstimation {
  readonly totalCost: MoneyRange;
  readonly totalWorkerTimeMs: DurationRange;
  readonly privacyImpacts: readonly PrivacyImpact[];
  readonly dataLeavesDevice: boolean;
  readonly remoteProviders: readonly string[];
  readonly confidence: 'low' | 'medium' | 'high';
}

export function estimatePlan(
  plan: AgentEditPlan,
  registry: ToolRegistry,
  context: EditorContext,
): PlanEstimation {
  const costs: Money[] = [];
  const workerTimes: number[] = [];
  const privacyImpacts: PrivacyImpact[] = [];
  const remoteProviders = new Set<string>();
  let allHaveEstimates = true;

  for (const step of plan.steps) {
    const estimation = estimateStep(step, registry, context);

    if (estimation.cost) {
      if (estimation.cost.providerCost) {
        costs.push(estimation.cost.providerCost);
      }
      if (estimation.cost.workerTimeMs !== undefined) {
        workerTimes.push(estimation.cost.workerTimeMs);
      }
    } else {
      allHaveEstimates = false;
    }

    if (estimation.privacy) {
      privacyImpacts.push(estimation.privacy);
      if (estimation.privacy.dataLeavesDevice && estimation.privacy.providerId) {
        remoteProviders.add(estimation.privacy.providerId);
      }
    }
  }

  const totalCost: MoneyRange =
    costs.length > 0
      ? {
          min: sumMoney(costs, 'min'),
          max: sumMoney(costs, 'max'),
        }
      : { min: { amount: '0.00', currency: 'USD' }, max: { amount: '0.00', currency: 'USD' } };

  const totalWorkerTimeMs: DurationRange =
    workerTimes.length > 0
      ? { minMs: Math.min(...workerTimes), maxMs: Math.max(...workerTimes) }
      : { minMs: 0, maxMs: 0 };

  const dataLeavesDevice = privacyImpacts.some((p) => p.dataLeavesDevice);

  const confidence: 'low' | 'medium' | 'high' =
    plan.steps.length === 0
      ? 'low'
      : allHaveEstimates
        ? 'high'
        : plan.steps.length <= 3
          ? 'medium'
          : 'low';

  return {
    totalCost,
    totalWorkerTimeMs,
    privacyImpacts,
    dataLeavesDevice,
    remoteProviders: [...remoteProviders],
    confidence,
  };
}

export function estimateStep(
  step: AgentPlanStep,
  _registry: ToolRegistry,
  _context: EditorContext,
): { cost?: CostEstimate; privacy?: PrivacyImpact } {
  const cost = step.estimatedCost;

  let privacy: PrivacyImpact | undefined;
  if (cost) {
    const providerId = cost.localOnly ? undefined : _context.providers.availableProviders[0]?.id;
    privacy = {
      dataLeavesDevice: !cost.localOnly,
      ...(providerId !== undefined && { providerId }),
      dataTypes: inferDataTypes(step.tool),
    };
  } else {
    const tool = _registry.getTool(step.tool);
    if (!tool) {
      return {};
    }

    const toolDef = 'definition' in tool ? tool.definition : null;
    const requiresProvider =
      toolDef?.scope.capabilities.includes('provider.generate') === true ||
      toolDef?.scope.capabilities.includes('provider.spend') === true;

    if (requiresProvider) {
      const provider = _context.providers.availableProviders[0];

      if (provider) {
        privacy = {
          dataLeavesDevice: provider.dataLeavesDevice,
          providerId: provider.id,
          dataTypes: inferDataTypes(step.tool),
        };
      } else {
        privacy = {
          dataLeavesDevice: !_context.providers.localOnly,
          dataTypes: inferDataTypes(step.tool),
        };
      }
    } else {
      privacy = {
        dataLeavesDevice: false,
        dataTypes: [],
      };
    }
  }

  return {
    ...(cost !== undefined && { cost }),
    ...(privacy !== undefined && { privacy }),
  };
}

export function isPlanLocalOnly(
  plan: AgentEditPlan,
  registry: ToolRegistry,
  context: EditorContext,
): boolean {
  for (const step of plan.steps) {
    const estimation = estimateStep(step, registry, context);
    if (estimation.privacy?.dataLeavesDevice) {
      return false;
    }
  }
  return true;
}

function sumMoney(costs: Money[], _type: 'min' | 'max'): Money {
  if (costs.length === 0) {
    return { amount: '0.00', currency: 'USD' };
  }

  const currency = costs[0]?.currency ?? 'USD';
  const total = costs.reduce((sum, c) => sum + parseFloat(c.amount), 0);
  return { amount: total.toFixed(2), currency };
}

function inferDataTypes(toolName: string): readonly string[] {
  const lower = toolName.toLowerCase();
  if (lower.includes('transcri') || lower.includes('speech')) {
    return ['audio data'];
  }
  if (lower.includes('voice') || lower.includes('clone')) {
    return ['audio samples', 'voice profile'];
  }
  if (lower.includes('image')) {
    return ['image data'];
  }
  if (lower.includes('video')) {
    return ['video data'];
  }
  if (lower.includes('music') || lower.includes('audio')) {
    return ['audio data'];
  }
  return ['unknown data'];
}
