import type {
  AnyProvider,
  CapabilityRequest,
  ProviderPolicy,
  ProviderResolution,
  Money,
} from './types.js';
import {
  getProviderId,
  supportsCapability,
  getExecution,
  getDataLeavesDevice,
  getCapabilityDeclaration,
  isLocalExecution,
  compareMoney,
} from './utils.js';

export function resolveProvider(
  request: CapabilityRequest,
  available: readonly AnyProvider[],
  policy: ProviderPolicy,
): ProviderResolution {
  if (policy.blockedCapabilities.includes(request.capability)) {
    return {
      status: 'blocked-by-policy',
      reason: `Capability '${request.capability}' is blocked by policy`,
    };
  }

  const capable = available.filter((p) => supportsCapability(p, request.capability));
  if (capable.length === 0) {
    return {
      status: 'no-eligible',
      reason: `No providers support capability '${request.capability}'`,
    };
  }

  const notBlocked = capable.filter((p) => !policy.blockedProviders.includes(getProviderId(p)));
  if (notBlocked.length === 0) {
    return {
      status: 'blocked-by-policy',
      reason: 'All capable providers are blocked by policy',
    };
  }

  let candidates = [...notBlocked];

  if (!policy.allowRemote) {
    candidates = candidates.filter((p) => isLocalExecution(getExecution(p)));
  }

  if (policy.requireLocalFor.includes(request.capability)) {
    candidates = candidates.filter((p) => isLocalExecution(getExecution(p)));
  }

  if (
    request.constraints.executionPreference &&
    request.constraints.executionPreference.length > 0
  ) {
    candidates = candidates.filter((p) => {
      const exec = getExecution(p);
      const isLocal = isLocalExecution(exec);
      if (request.constraints.executionPreference!.includes('local') && isLocal) return true;
      if (request.constraints.executionPreference!.includes('remote') && !isLocal) return true;
      return false;
    });
  }

  if (request.constraints.requiredPrivacy === 'local-only') {
    candidates = candidates.filter((p) => {
      const leaves = getDataLeavesDevice(p);
      return leaves === false;
    });
  }

  if (request.constraints.modelAllowlist && request.constraints.modelAllowlist.length > 0) {
    candidates = candidates.filter((p) => {
      const decl = getCapabilityDeclaration(p, request.capability);
      if (!decl?.models || decl.models.length === 0) return true;
      return decl.models.some((m) => request.constraints.modelAllowlist!.includes(m.id));
    });
  }

  const maxCost = resolveMaxCost(request.constraints.maxCost, policy.maxCostPerRequest);
  if (maxCost) {
    candidates = candidates.filter((p) => {
      const decl = getCapabilityDeclaration(p, request.capability);
      if (!decl?.pricing) return true;
      const cost: Money = { amount: decl.pricing.rate, currency: decl.pricing.currency };
      return compareMoney(cost, maxCost) <= 0;
    });
  }

  if (candidates.length === 0) {
    return {
      status: 'no-eligible',
      reason: 'No providers match the given constraints',
    };
  }

  const ranked = rankCandidates(candidates, request);

  if (ranked.length === 1) {
    return {
      status: 'resolved',
      provider: ranked[0]!,
      candidates: ranked,
    };
  }

  return {
    status: 'resolved',
    provider: ranked[0]!,
    candidates: ranked,
  };
}

function resolveMaxCost(
  requestCost: Money | undefined,
  policyCost: Money | undefined,
): Money | undefined {
  if (requestCost && policyCost) {
    return compareMoney(requestCost, policyCost) < 0 ? requestCost : policyCost;
  }
  return requestCost ?? policyCost;
}

function rankCandidates(candidates: AnyProvider[], request: CapabilityRequest): AnyProvider[] {
  return candidates.sort((a, b) => {
    const scoreA = computeScore(a, request);
    const scoreB = computeScore(b, request);
    return scoreB - scoreA;
  });
}

function computeScore(provider: AnyProvider, request: CapabilityRequest): number {
  let score = 0;
  const exec = getExecution(provider);

  if (isLocalExecution(exec)) {
    score += 100;
  }

  if (request.constraints.executionPreference) {
    if (request.constraints.executionPreference.includes('local') && isLocalExecution(exec)) {
      score += 50;
    }
    if (request.constraints.executionPreference.includes('remote') && !isLocalExecution(exec)) {
      score += 50;
    }
  }

  const decl = getCapabilityDeclaration(provider, request.capability);
  if (decl?.estimatedResources?.estimatedDurationMs) {
    score -= decl.estimatedResources.estimatedDurationMs / 1000;
  }

  if (decl?.pricing) {
    score -= parseFloat(decl.pricing.rate) * 10;
  }

  return score;
}
