import type { AgentExecutionMode, ApprovalPolicy, ToolCapability } from '@joy-media/agent-tools';
import {
  ALL_TOOL_CAPABILITIES,
  createAutoApplyLowRiskPolicy,
  createFullAutoWithinLimitsPolicy,
  createPreviewAndApprovePolicy,
  createSuggestOnlyApprovalPolicy,
} from '@joy-media/agent-tools';

export const AGENT_POLICY_STORAGE_KEY = 'joy-media.agent-policy.v2';
export const LEGACY_AGENT_SETTINGS_STORAGE_KEY = 'joy-media.agent-settings.v1';

export interface AgentPolicyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/**
 * The budgets of the quality check and the switch that keeps pictures on this PC (ADR-0045
 * sections 5 and 8; T-B05). The numbers are limits on what the check may send, not a price.
 */
export interface QualityCheckPreferences {
  /** The most pictures one check may look at. */
  readonly framesPerCheck: number;
  /** The most pictures one run may look at in all, across its fix rounds. */
  readonly framesPerRun: number;
  /** The most fix rounds one run may make. */
  readonly fixRounds: number;
  /** When true, the future quality check should keep pictures on this PC. */
  readonly neverSendFramesToRemoteModel: boolean;
}

export type QualityCheckBudgetKey = 'framesPerCheck' | 'framesPerRun' | 'fixRounds';

export interface QualityCheckBudgetBounds {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

/** The bounds and defaults of each budget (ADR-0045 section 8). Each value is a whole number. */
export const QUALITY_CHECK_BUDGET_BOUNDS: Readonly<
  Record<QualityCheckBudgetKey, QualityCheckBudgetBounds>
> = Object.freeze({
  framesPerCheck: Object.freeze({ min: 1, max: 16, default: 12 }),
  framesPerRun: Object.freeze({ min: 12, max: 48, default: 16 }),
  fixRounds: Object.freeze({ min: 1, max: 3, default: 3 }),
});

export const DEFAULT_QUALITY_CHECK: QualityCheckPreferences = Object.freeze({
  framesPerCheck: QUALITY_CHECK_BUDGET_BOUNDS.framesPerCheck.default,
  framesPerRun: QUALITY_CHECK_BUDGET_BOUNDS.framesPerRun.default,
  fixRounds: QUALITY_CHECK_BUDGET_BOUNDS.fixRounds.default,
  neverSendFramesToRemoteModel: false,
});

/** Rounds a typed budget to a whole number and keeps it inside its bounds. A value that is not a number gives the default. */
export function clampQualityCheckBudget(key: QualityCheckBudgetKey, value: unknown): number {
  const bounds = QUALITY_CHECK_BUDGET_BOUNDS[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return bounds.default;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

export interface AgentPolicyPreferences {
  readonly version: 2;
  readonly executionMode: AgentExecutionMode;
  readonly allowedCapabilities: readonly ToolCapability[];
  readonly maxCostPerRunUsd: number;
  readonly privacyMode: 'ask-before-remote' | 'local-only';
  /** The only supported reasoning executor for new runs. */
  readonly workerPreference: 'browser-worker';
  readonly mediaProvider: string;
  readonly livePreview: boolean;
  readonly qualityCheck: QualityCheckPreferences;
}

/** Fresh-install threshold for asking before a step is auto-approved. */
export const DEFAULT_MAX_COST_PER_RUN_USD = 10;

export const DEFAULT_AGENT_POLICY: AgentPolicyPreferences = {
  version: 2,
  executionMode: 'preview-and-approve',
  allowedCapabilities: ALL_TOOL_CAPABILITIES,
  maxCostPerRunUsd: DEFAULT_MAX_COST_PER_RUN_USD,
  privacyMode: 'ask-before-remote',
  workerPreference: 'browser-worker',
  mediaProvider: 'Approved provider',
  livePreview: true,
  qualityCheck: DEFAULT_QUALITY_CHECK,
};

/** Local compound edits have no additional provider/job cost. Model token spend is
 * unknown for arbitrary BYOK providers and is never represented as a dollar cap. */
export const MODEL_APPLY_COST_GUARD = Object.freeze({
  additionalApplyCostUsd: 0,
  providerSpend: 'unknown' as const,
  maxProviderSteps: 4,
  maxOutputTokensPerStep: 2048,
});

export function assertModelApplyPolicy(preferences: AgentPolicyPreferences): void {
  if (preferences.executionMode === 'suggest-only')
    throw new Error('Suggest-only mode does not permit applying model edits.');
  if (!preferences.allowedCapabilities.includes('timeline.write'))
    throw new Error('The current policy denies timeline and document edits.');
  if (!Number.isFinite(preferences.maxCostPerRunUsd) || preferences.maxCostPerRunUsd < 0)
    throw new Error('The current cost limit is invalid.');
}

export function loadAgentPolicy(storage: AgentPolicyStorage): AgentPolicyPreferences {
  const current = storage.getItem(AGENT_POLICY_STORAGE_KEY);
  if (current !== null) {
    try {
      return normalizeAgentPolicy(JSON.parse(current));
    } catch {
      return DEFAULT_AGENT_POLICY;
    }
  }

  const legacy = storage.getItem(LEGACY_AGENT_SETTINGS_STORAGE_KEY);
  if (legacy === null) return DEFAULT_AGENT_POLICY;

  let migrated = DEFAULT_AGENT_POLICY;
  try {
    migrated = migrateLegacyAgentSettings(JSON.parse(legacy));
  } catch {
    migrated = DEFAULT_AGENT_POLICY;
  }
  saveAgentPolicy(storage, migrated);
  storage.removeItem?.(LEGACY_AGENT_SETTINGS_STORAGE_KEY);
  return migrated;
}

export function saveAgentPolicy(
  storage: AgentPolicyStorage,
  preferences: AgentPolicyPreferences,
): void {
  const normalized = normalizeAgentPolicy(preferences);
  storage.setItem(AGENT_POLICY_STORAGE_KEY, JSON.stringify(normalized));
  storage.removeItem?.(LEGACY_AGENT_SETTINGS_STORAGE_KEY);
}

export function approvalPolicyForAgentPolicy(preferences: AgentPolicyPreferences): ApprovalPolicy {
  const base = policyForMode(preferences.executionMode);
  return {
    ...base,
    allowedCapabilities: preferences.allowedCapabilities,
    blockRemoteUploads: preferences.privacyMode === 'local-only',
    ...(preferences.executionMode === 'full-auto-limited'
      ? {
          autoApproveLimit: {
            amount: preferences.maxCostPerRunUsd.toFixed(2),
            currency: 'USD',
          },
        }
      : {}),
  };
}

function policyForMode(mode: AgentExecutionMode): ApprovalPolicy {
  switch (mode) {
    case 'suggest-only':
      return createSuggestOnlyApprovalPolicy();
    case 'preview-and-approve':
      return createPreviewAndApprovePolicy();
    case 'auto-apply-low-risk':
      return createAutoApplyLowRiskPolicy();
    case 'full-auto-limited':
      return createFullAutoWithinLimitsPolicy();
  }
}

function normalizeAgentPolicy(value: unknown): AgentPolicyPreferences {
  if (typeof value !== 'object' || value === null) return DEFAULT_AGENT_POLICY;
  const candidate = value as Partial<AgentPolicyPreferences>;
  const modes: readonly AgentExecutionMode[] = [
    'suggest-only',
    'preview-and-approve',
    'auto-apply-low-risk',
    'full-auto-limited',
  ];
  const capabilities = Array.isArray(candidate.allowedCapabilities)
    ? candidate.allowedCapabilities.filter(
        (capability): capability is ToolCapability =>
          typeof capability === 'string' &&
          ALL_TOOL_CAPABILITIES.includes(capability as ToolCapability),
      )
    : DEFAULT_AGENT_POLICY.allowedCapabilities;
  return {
    version: 2,
    executionMode: modes.includes(candidate.executionMode as AgentExecutionMode)
      ? (candidate.executionMode as AgentExecutionMode)
      : DEFAULT_AGENT_POLICY.executionMode,
    allowedCapabilities: [...new Set(capabilities)],
    maxCostPerRunUsd:
      typeof candidate.maxCostPerRunUsd === 'number' &&
      Number.isFinite(candidate.maxCostPerRunUsd) &&
      candidate.maxCostPerRunUsd >= 0
        ? Math.min(10_000, candidate.maxCostPerRunUsd)
        : DEFAULT_AGENT_POLICY.maxCostPerRunUsd,
    privacyMode: candidate.privacyMode === 'local-only' ? 'local-only' : 'ask-before-remote',
    // Older policies carried local/approved-executor values. They are
    // intentionally collapsed to the single built-in browser Worker so a
    // stale preference can never re-enable a retired local engine.
    workerPreference: 'browser-worker',
    mediaProvider:
      typeof candidate.mediaProvider === 'string' && candidate.mediaProvider.trim().length > 0
        ? candidate.mediaProvider.trim()
        : DEFAULT_AGENT_POLICY.mediaProvider,
    livePreview: candidate.livePreview !== false,
    qualityCheck: normalizeQualityCheck(candidate.qualityCheck),
  };
}

/**
 * A policy saved before the quality check existed has no `qualityCheck`, and one saved with
 * part of it has only some keys. Each missing or unusable key takes its ADR default.
 */
function normalizeQualityCheck(value: unknown): QualityCheckPreferences {
  const candidate =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const framesPerRun = clampQualityCheckBudget('framesPerRun', candidate.framesPerRun);
  return {
    framesPerCheck: Math.min(
      clampQualityCheckBudget('framesPerCheck', candidate.framesPerCheck),
      framesPerRun,
    ),
    framesPerRun,
    fixRounds: clampQualityCheckBudget('fixRounds', candidate.fixRounds),
    neverSendFramesToRemoteModel: candidate.neverSendFramesToRemoteModel === true,
  };
}

function migrateLegacyAgentSettings(value: unknown): AgentPolicyPreferences {
  if (typeof value !== 'object' || value === null) return DEFAULT_AGENT_POLICY;
  const candidate = value as Record<string, unknown>;
  return normalizeAgentPolicy({
    executionMode: candidate.executionMode,
    allowedCapabilities: candidate.allowedCapabilities,
    maxCostPerRunUsd: candidate.maxCostPerRunUsd,
    privacyMode: candidate.privacyMode,
    workerPreference: candidate.workerPreference,
    mediaProvider: candidate.mediaProvider,
    livePreview: true,
  });
}
