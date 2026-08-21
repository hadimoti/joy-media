import type {
  AnyProvider,
  CapabilityRequest,
  Money,
  ProviderCandidateDecisionV1,
  ProviderCandidateGateResultV1,
  ProviderCandidateGateV1,
  ProviderDecisionV1,
  ProviderPolicy,
  ProviderScoreBreakdownV1,
  ProviderUsage,
} from './types.js';
import {
  compareMoney,
  getCapabilityDeclaration,
  getDataLeavesDevice,
  getExecution,
  getProviderId,
  isLocalExecution,
  supportsCapability,
} from './utils.js';

export interface ProviderDecisionOptions {
  readonly createdAt?: string;
  readonly productionRunId?: string;
  readonly providerUsage?: ProviderUsage;
  readonly unavailableProviderIds?: readonly string[];
  readonly deniedProviderIds?: readonly string[];
  readonly requireManualChoiceOnTie?: boolean;
}

export function decideProvider(
  request: CapabilityRequest,
  available: readonly AnyProvider[],
  policy: ProviderPolicy,
  options: ProviderDecisionOptions = {},
): ProviderDecisionV1 {
  const candidates = available.map((provider) =>
    decideCandidate(provider, request, policy, options),
  );
  const eligible = candidates
    .filter((candidate) => candidate.status === 'eligible')
    .sort((left, right) => {
      const scoreDelta = (right.scoreBreakdown?.total ?? 0) - (left.scoreBreakdown?.total ?? 0);
      if (scoreDelta !== 0) return scoreDelta;
      return left.providerId.localeCompare(right.providerId);
    });

  const decisionId = createDecisionId(request);
  const base = {
    decisionVersion: 1 as const,
    decisionId,
    idempotencyKey: request.idempotencyKey,
    capability: request.capability,
    candidates,
    createdAt: options.createdAt ?? new Date().toISOString(),
    ...(options.productionRunId === undefined ? {} : { productionRunId: options.productionRunId }),
    ...(options.providerUsage === undefined
      ? {}
      : {
          providerUsage: linkProviderUsage(
            options.providerUsage,
            decisionId,
            options.productionRunId,
          ),
        }),
  };

  if (eligible.length === 0) {
    const hasAnyCapable = candidates.some(
      (candidate) => candidate.rejectedBy !== 'capability' && candidate.rejectedBy !== undefined,
    );
    const rejectedByAvailability = candidates.some(
      (candidate) => candidate.rejectedBy === 'availability',
    );
    const status = !hasAnyCapable || rejectedByAvailability ? 'unavailable' : 'denied';
    return {
      ...base,
      status,
      reason:
        status === 'unavailable'
          ? `No available providers can satisfy '${request.capability}'`
          : `Provider policy denied '${request.capability}'`,
    };
  }

  const top = eligible[0]!;
  const tied = eligible.filter(
    (candidate) => candidate.scoreBreakdown?.total === top.scoreBreakdown?.total,
  );
  const rankedCandidates = [
    ...eligible,
    ...candidates.filter((candidate) => candidate.status === 'rejected'),
  ];

  if (options.requireManualChoiceOnTie === true && tied.length > 1) {
    return {
      ...base,
      candidates: rankedCandidates,
      status: 'manual-choice-required',
      reason: `Top provider tie requires manual choice: ${tied
        .map((candidate) => candidate.providerId)
        .join(', ')}`,
    };
  }

  return {
    ...base,
    candidates: rankedCandidates,
    status: 'selected',
    selectedProviderId: top.providerId,
    reason: `Selected '${top.providerId}' for '${request.capability}'`,
  };
}

function decideCandidate(
  provider: AnyProvider,
  request: CapabilityRequest,
  policy: ProviderPolicy,
  options: ProviderDecisionOptions,
): ProviderCandidateDecisionV1 {
  const providerId = getProviderId(provider);
  const execution = getExecution(provider);
  const gates: ProviderCandidateGateResultV1[] = [];

  pushGate(gates, 'capability-policy', !policy.blockedCapabilities.includes(request.capability), {
    pass: `Capability '${request.capability}' is allowed by policy`,
    fail: `Capability '${request.capability}' is blocked by policy`,
  });
  pushGate(gates, 'capability', supportsCapability(provider, request.capability), {
    pass: `Provider supports '${request.capability}'`,
    fail: `Provider does not support '${request.capability}'`,
  });
  pushGate(gates, 'provider-policy', !policy.blockedProviders.includes(providerId), {
    pass: 'Provider is not blocked by policy',
    fail: 'Provider is blocked by policy',
  });
  pushGate(gates, 'authorization', !options.deniedProviderIds?.includes(providerId), {
    pass: 'Provider authorization is available',
    fail: 'Provider authorization was denied',
  });
  pushGate(gates, 'availability', !options.unavailableProviderIds?.includes(providerId), {
    pass: 'Provider is available',
    fail: 'Provider is unavailable',
  });
  pushGate(gates, 'remote-policy', remoteAllowed(provider, request, policy), {
    pass: 'Execution locality is allowed by policy',
    fail: 'Remote execution is blocked by policy',
  });
  pushGate(gates, 'execution-preference', matchesExecutionPreference(provider, request), {
    pass: 'Provider matches execution preference',
    fail: 'Provider does not match execution preference',
  });
  pushGate(gates, 'privacy', matchesPrivacy(provider, request), {
    pass: 'Provider satisfies privacy requirements',
    fail: 'Provider violates local-only privacy requirements',
  });
  pushGate(gates, 'model', matchesModelAllowlist(provider, request), {
    pass: 'Provider satisfies model constraints',
    fail: 'Provider models are outside the allowlist',
  });
  pushGate(gates, 'cost', matchesCost(provider, request, policy), {
    pass: 'Provider satisfies cost constraints',
    fail: 'Provider price exceeds the configured cap or currency',
  });

  const failed = gates.find((gate) => gate.status === 'failed');
  const declaration = getCapabilityDeclaration(provider, request.capability);
  const estimatedCost =
    declaration?.pricing === undefined
      ? undefined
      : { amount: declaration.pricing.rate, currency: declaration.pricing.currency };
  const modelId = declaration?.models?.[0]?.id;

  const candidate = {
    candidateVersion: 1 as const,
    providerId,
    displayName: getDisplayName(provider),
    capability: request.capability,
    execution,
    gates,
    ...(estimatedCost === undefined ? {} : { estimatedCost }),
    ...(modelId === undefined ? {} : { modelId }),
  };

  if (failed !== undefined) {
    return {
      ...candidate,
      status: 'rejected',
      rejectedBy: failed.gate,
    };
  }

  return {
    ...candidate,
    status: 'eligible',
    scoreBreakdown: scoreProvider(provider, request, policy),
  };
}

function scoreProvider(
  provider: AnyProvider,
  request: CapabilityRequest,
  policy: ProviderPolicy,
): ProviderScoreBreakdownV1 {
  const execution = getExecution(provider);
  const local = isLocalExecution(execution);
  const declaration = getCapabilityDeclaration(provider, request.capability);
  const price = declaration?.pricing;
  const maxCost = resolveMaxCost(request.constraints.maxCost, policy.maxCostPerRequest);
  const rate = price === undefined ? undefined : parseFloat(price.rate);
  const maxRate = maxCost === undefined ? undefined : parseFloat(maxCost.amount);
  const duration = declaration?.estimatedResources?.estimatedDurationMs;
  const maxDuration = request.constraints.maxDurationMs ?? 120_000;

  const dimensions: ProviderScoreBreakdownV1['dimensions'] = {
    capability: {
      score: 1,
      explanation: `Supports '${request.capability}'`,
    },
    privacy: {
      score: getDataLeavesDevice(provider) === false ? 1 : 0.65,
      explanation:
        getDataLeavesDevice(provider) === false
          ? 'Data stays on device'
          : 'Data may leave device under approved policy',
    },
    locality: {
      score: local ? 1 : 0.35,
      explanation: local ? 'Local execution preferred by default' : 'Remote execution is available',
    },
    preference: {
      score: preferenceScore(provider, request),
      explanation: 'Execution preference alignment',
    },
    cost: {
      score:
        rate === undefined
          ? 0.75
          : maxRate === undefined || maxRate <= 0
            ? clamp01(1 - rate)
            : clamp01(1 - rate / maxRate),
      explanation:
        price === undefined ? 'No provider price declared' : `${price.rate} ${price.currency}`,
    },
    latency: {
      score: duration === undefined ? 0.75 : clamp01(1 - duration / maxDuration),
      explanation: duration === undefined ? 'No duration estimate declared' : `${duration}ms`,
    },
    availability: {
      score: 1,
      explanation: 'Provider is currently available',
    },
  };

  const total =
    Object.values(dimensions).reduce((sum, dimension) => sum + dimension.score, 0) /
    Object.keys(dimensions).length;

  return {
    scoreVersion: 1,
    dimensions,
    total: roundScore(total),
  };
}

function pushGate(
  gates: ProviderCandidateGateResultV1[],
  gate: ProviderCandidateGateV1,
  passed: boolean,
  reasons: { readonly pass: string; readonly fail: string },
): void {
  gates.push({
    gate,
    status: passed ? 'passed' : 'failed',
    reason: passed ? reasons.pass : reasons.fail,
  });
}

function remoteAllowed(
  provider: AnyProvider,
  request: CapabilityRequest,
  policy: ProviderPolicy,
): boolean {
  const local = isLocalExecution(getExecution(provider));
  if (!policy.allowRemote && !local) return false;
  if (policy.requireLocalFor.includes(request.capability) && !local) return false;
  return true;
}

function matchesExecutionPreference(provider: AnyProvider, request: CapabilityRequest): boolean {
  const preference = request.constraints.executionPreference;
  if (preference === undefined || preference.length === 0) return true;
  const local = isLocalExecution(getExecution(provider));
  return (preference.includes('local') && local) || (preference.includes('remote') && !local);
}

function matchesPrivacy(provider: AnyProvider, request: CapabilityRequest): boolean {
  if (request.constraints.requiredPrivacy !== 'local-only') return true;
  return getDataLeavesDevice(provider) === false;
}

function matchesModelAllowlist(provider: AnyProvider, request: CapabilityRequest): boolean {
  const allowlist = request.constraints.modelAllowlist;
  if (allowlist === undefined || allowlist.length === 0) return true;
  const models = getCapabilityDeclaration(provider, request.capability)?.models;
  if (models === undefined || models.length === 0) return true;
  return models.some((model) => allowlist.includes(model.id));
}

function matchesCost(
  provider: AnyProvider,
  request: CapabilityRequest,
  policy: ProviderPolicy,
): boolean {
  const maxCost = resolveMaxCost(request.constraints.maxCost, policy.maxCostPerRequest);
  if (maxCost === undefined) return true;
  const pricing = getCapabilityDeclaration(provider, request.capability)?.pricing;
  if (pricing === undefined) return true;
  if (pricing.currency !== maxCost.currency) return false;
  return compareMoney({ amount: pricing.rate, currency: pricing.currency }, maxCost) <= 0;
}

function resolveMaxCost(
  requestCost: Money | undefined,
  policyCost: Money | undefined,
): Money | undefined {
  if (requestCost !== undefined && policyCost !== undefined) {
    if (requestCost.currency !== policyCost.currency) return requestCost;
    return compareMoney(requestCost, policyCost) < 0 ? requestCost : policyCost;
  }
  return requestCost ?? policyCost;
}

function preferenceScore(provider: AnyProvider, request: CapabilityRequest): number {
  const preference = request.constraints.executionPreference;
  if (preference === undefined || preference.length === 0) return 0.75;
  return matchesExecutionPreference(provider, request) ? 1 : 0;
}

function getDisplayName(provider: AnyProvider): string {
  return 'displayName' in provider.manifest ? provider.manifest.displayName : provider.manifest.id;
}

function linkProviderUsage(
  usage: ProviderUsage,
  providerDecisionId: string,
  productionRunId: string | undefined,
): ProviderUsage {
  return {
    ...usage,
    providerDecisionId,
    ...(productionRunId === undefined ? {} : { productionRunId }),
  };
}

function createDecisionId(request: CapabilityRequest): string {
  return `provider-decision-${request.idempotencyKey.replace(/[^A-Za-z0-9._:-]/g, '-')}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
