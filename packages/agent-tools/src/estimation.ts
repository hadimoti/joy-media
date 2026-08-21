import type { ToolRegistry } from './registry.js';
import type { EditorContext, ProviderSummary } from './context.js';
import type { CapabilityId } from '@joy-media/provider-sdk';
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
  registry: ToolRegistry,
  context: EditorContext,
): { cost?: CostEstimate; privacy?: PrivacyImpact } {
  const inferredCapability = inferProviderCapability(step.tool);
  const provider = pickProvider(context, inferredCapability);
  const providerEstimate =
    step.estimatedCost === undefined && provider !== undefined && inferredCapability !== undefined
      ? estimateProviderCost(provider, inferredCapability)
      : undefined;
  const cost = step.estimatedCost ?? providerEstimate;

  let privacy: PrivacyImpact | undefined;
  if (cost) {
    const providerId = cost.localOnly ? undefined : provider?.id;
    privacy = {
      dataLeavesDevice: !cost.localOnly,
      ...(providerId !== undefined && { providerId }),
      dataTypes: inferDataTypes(step.tool),
    };
  } else {
    const tool = registry.getTool(step.tool);
    if (!tool) {
      return {};
    }

    const toolDef = 'definition' in tool ? tool.definition : null;
    const requiresProvider =
      toolDef?.scope.capabilities.includes('provider.generate') === true ||
      toolDef?.scope.capabilities.includes('provider.spend') === true;

    if (requiresProvider) {
      if (provider) {
        privacy = {
          dataLeavesDevice: provider.dataLeavesDevice,
          providerId: provider.id,
          dataTypes: inferDataTypes(step.tool),
        };
      } else {
        privacy = {
          dataLeavesDevice: !context.providers.localOnly,
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

function pickProvider(
  context: EditorContext,
  capability: CapabilityId | undefined,
): ProviderSummary | undefined {
  if (capability === undefined) {
    return context.providers.availableProviders[0];
  }
  return (
    context.providers.availableProviders.find((provider) =>
      provider.capabilities.includes(capability),
    ) ?? context.providers.availableProviders[0]
  );
}

function estimateProviderCost(
  provider: ProviderSummary,
  capability: CapabilityId,
): CostEstimate | undefined {
  const detail = provider.capabilityDetails?.find(
    (candidate) => candidate.capability === capability,
  );
  if (detail === undefined) return undefined;
  const providerCost =
    detail.pricing === undefined
      ? undefined
      : { amount: detail.pricing.rate, currency: detail.pricing.currency };
  const workerTimeMs = detail.estimatedResources?.estimatedDurationMs;
  const localOnly = provider.execution === 'worker-local' || provider.execution === 'browser';
  if (providerCost === undefined && workerTimeMs === undefined) {
    return { localOnly };
  }
  return {
    localOnly,
    ...(providerCost === undefined ? {} : { providerCost }),
    ...(workerTimeMs === undefined ? {} : { workerTimeMs }),
  };
}

function inferProviderCapability(toolName: string): CapabilityId | undefined {
  const lower = toolName.toLowerCase();
  if (lower.includes('transcri')) return 'speech.transcribe';
  if (lower.includes('align')) return 'speech.align';
  if (lower.includes('diar')) return 'speech.diarize';
  if (lower.includes('synth') || lower.includes('tts')) return 'speech.synthesize';
  if (lower.includes('voice') && lower.includes('clone')) return 'voice.clone';
  if (lower.includes('denoise')) return 'audio.denoise';
  if (lower.includes('separate') || lower.includes('stem')) return 'audio.separate';
  if (lower.includes('music')) return 'music.generate';
  if (lower.includes('upscale')) return 'image.upscale';
  if (lower.includes('background') && lower.includes('remove') && lower.includes('image')) {
    return 'image.removeBackground';
  }
  if (lower.includes('image') && lower.includes('edit')) return 'image.edit';
  if (lower.includes('image')) return 'image.generate';
  if (lower.includes('interpolate')) return 'video.interpolate';
  if (lower.includes('animate')) return 'video.animate';
  if (lower.includes('background') && lower.includes('remove') && lower.includes('video')) {
    return 'video.removeBackground';
  }
  if (lower.includes('video')) return 'video.generate';
  if (lower.includes('embedding')) return 'embedding.create';
  if (lower.includes('vision')) return 'vision.analyze';
  if (lower.includes('llm') || lower.includes('complete')) return 'llm.complete';
  return undefined;
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
