import type { AgentExecutionMode, ApprovalPolicy, ToolCapability } from '@joy-media/agent-tools';
import {
  ALL_TOOL_CAPABILITIES,
  createAutoApplyLowRiskPolicy,
  createFullAutoWithinLimitsPolicy,
  createPreviewAndApprovePolicy,
  createSuggestOnlyApprovalPolicy,
} from '@joy-media/agent-tools';

export const AGENT_SETTINGS_STORAGE_KEY = 'joy-media.agent-settings.v1';

/** These are IDs, never provider credentials or arbitrary user-entered model names. */
export const CONFIGURABLE_REASONING_MODELS = ['mistral-small-latest'] as const;
export type ConfigurableReasoningModel = (typeof CONFIGURABLE_REASONING_MODELS)[number] | '';

export interface AgentSettings {
  readonly version: 1;
  readonly activeHost: 'kilocode';
  readonly executionMode: AgentExecutionMode;
  readonly reasoningModel: ConfigurableReasoningModel;
  readonly mediaProvider: string;
  readonly allowedCapabilities: readonly ToolCapability[];
  readonly maxCostPerRunUsd: number;
  readonly privacyMode: 'ask-before-remote' | 'local-only';
  readonly workerPreference: 'prefer-local' | 'any-approved';
  /** Local Windows-client Joy Code engine. Credentials never enter API requests. */
  readonly joyCodeEngine: 'cloud-openrouter' | 'local-deepseek-harness';
  readonly deepSeekHarnessEndpoint: string;
  readonly deepSeekHarnessModel: string;
  /** Kept only in the local settings store; never included in a project/request envelope. */
  readonly deepSeekHarnessApiKey: string;
  /** Explicit disclosure acknowledgement required before remote local-provider egress. */
  readonly localProviderDisclosureAccepted: boolean;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  version: 1,
  activeHost: 'kilocode',
  executionMode: 'preview-and-approve',
  reasoningModel: '',
  mediaProvider: 'Approved provider',
  allowedCapabilities: ALL_TOOL_CAPABILITIES,
  maxCostPerRunUsd: 10,
  privacyMode: 'ask-before-remote',
  workerPreference: 'prefer-local',
  joyCodeEngine: 'cloud-openrouter',
  deepSeekHarnessEndpoint: '',
  deepSeekHarnessModel: 'deepseek-chat',
  deepSeekHarnessApiKey: '',
  localProviderDisclosureAccepted: false,
};

export interface AgentSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Local credential boundary. The browser implementation is intentionally
 * memory-only; the Windows shell will replace it with an OS-native vault.
 */
export interface LocalCredentialStore {
  get(reference: string): string | undefined;
  set(reference: string, value: string): void;
  clear(reference: string): void;
}

export function createInMemoryCredentialStore(): LocalCredentialStore {
  const values = new Map<string, string>();
  return {
    get: (reference) => values.get(reference),
    set: (reference, value) => values.set(reference, value),
    clear: (reference) => values.delete(reference),
  };
}

export const LOCAL_DEEPSEEK_HARNESS_CREDENTIAL_REF = 'joy-media/local/deepseek-harness-api-key';

export interface LocalProviderPolicyContext {
  readonly endpointUrl: string;
  readonly authenticatedSessionReady: boolean;
  readonly disclosureAccepted: boolean;
}

/** Pure egress gate for the local-provider branch. */
export function canUseLocalDeepSeekHarness(
  settings: Pick<AgentSettings, 'privacyMode'>,
  context: LocalProviderPolicyContext,
): boolean {
  const loopback = isLoopbackEndpoint(context.endpointUrl);
  if (loopback) return true;
  return (
    settings.privacyMode === 'ask-before-remote' &&
    context.authenticatedSessionReady &&
    context.disclosureAccepted
  );
}

export function loadAgentSettings(storage: AgentSettingsStorage): AgentSettings {
  const raw = storage.getItem(AGENT_SETTINGS_STORAGE_KEY);
  if (raw === null) return DEFAULT_AGENT_SETTINGS;
  try {
    return normalizeAgentSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_AGENT_SETTINGS;
  }
}

export function saveAgentSettings(storage: AgentSettingsStorage, settings: AgentSettings): void {
  // API keys are deliberately excluded. A native Windows vault will own the
  // credential boundary; web localStorage is preferences-only.
  const { deepSeekHarnessApiKey: _ignoredApiKey, ...preferences } = settings;
  void _ignoredApiKey;
  storage.setItem(AGENT_SETTINGS_STORAGE_KEY, JSON.stringify(preferences));
}

/**
 * Returns the local provider settings needed by the future Windows shell.
 * This is intentionally a separate, explicit projection: callers cannot
 * accidentally pass the complete AgentSettings object to cloud APIs.
 */
export interface LocalDeepSeekHarnessSettings {
  readonly endpointUrl: string;
  readonly modelId: string;
  readonly apiKey: string;
}

export function localDeepSeekHarnessSettings(
  settings: AgentSettings,
  credentialStore?: LocalCredentialStore,
): LocalDeepSeekHarnessSettings | undefined {
  if (settings.joyCodeEngine !== 'local-deepseek-harness') return undefined;
  const endpointUrl = settings.deepSeekHarnessEndpoint.trim();
  const modelId = settings.deepSeekHarnessModel.trim();
  const apiKey = (credentialStore?.get(LOCAL_DEEPSEEK_HARNESS_CREDENTIAL_REF) ?? '').trim();
  if (endpointUrl === '' || modelId === '' || apiKey === '') return undefined;
  return { endpointUrl, modelId, apiKey };
}

/**
 * The local engine selection is fail-closed: an incomplete or disallowed local
 * configuration must not silently fall back to the cloud planner.
 */
export function canRunLocalDeepSeekHarness(
  settings: Pick<AgentSettings, 'joyCodeEngine' | 'privacyMode'>,
  localSettings: LocalDeepSeekHarnessSettings | undefined,
  context: LocalProviderPolicyContext,
): boolean {
  return (
    settings.joyCodeEngine === 'local-deepseek-harness' &&
    localSettings !== undefined &&
    canUseLocalDeepSeekHarness(settings, context)
  );
}

export function approvalPolicyForAgentSettings(settings: AgentSettings): ApprovalPolicy {
  const base = policyForMode(settings.executionMode);
  return {
    ...base,
    allowedCapabilities: settings.allowedCapabilities,
    blockRemoteUploads: settings.privacyMode === 'local-only',
    ...(settings.executionMode === 'full-auto-limited'
      ? {
          autoApproveLimit: {
            amount: settings.maxCostPerRunUsd.toFixed(2),
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

function normalizeAgentSettings(value: unknown): AgentSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_AGENT_SETTINGS;
  const candidate = value as Partial<AgentSettings>;
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
    : DEFAULT_AGENT_SETTINGS.allowedCapabilities;
  return {
    version: 1,
    activeHost: 'kilocode',
    executionMode: modes.includes(candidate.executionMode as AgentExecutionMode)
      ? (candidate.executionMode as AgentExecutionMode)
      : DEFAULT_AGENT_SETTINGS.executionMode,
    reasoningModel:
      typeof candidate.reasoningModel === 'string' &&
      CONFIGURABLE_REASONING_MODELS.includes(
        candidate.reasoningModel.trim() as (typeof CONFIGURABLE_REASONING_MODELS)[number],
      )
        ? (candidate.reasoningModel.trim() as ConfigurableReasoningModel)
        : DEFAULT_AGENT_SETTINGS.reasoningModel,
    mediaProvider:
      typeof candidate.mediaProvider === 'string' && candidate.mediaProvider.trim().length > 0
        ? candidate.mediaProvider.trim()
        : DEFAULT_AGENT_SETTINGS.mediaProvider,
    allowedCapabilities:
      capabilities.length > 0
        ? [...new Set(capabilities)]
        : DEFAULT_AGENT_SETTINGS.allowedCapabilities,
    maxCostPerRunUsd:
      typeof candidate.maxCostPerRunUsd === 'number' &&
      Number.isFinite(candidate.maxCostPerRunUsd) &&
      candidate.maxCostPerRunUsd >= 0
        ? Math.min(10_000, candidate.maxCostPerRunUsd)
        : DEFAULT_AGENT_SETTINGS.maxCostPerRunUsd,
    privacyMode: candidate.privacyMode === 'local-only' ? 'local-only' : 'ask-before-remote',
    workerPreference:
      candidate.workerPreference === 'any-approved' ? 'any-approved' : 'prefer-local',
    joyCodeEngine:
      candidate.joyCodeEngine === 'local-deepseek-harness'
        ? 'local-deepseek-harness'
        : 'cloud-openrouter',
    deepSeekHarnessEndpoint:
      typeof candidate.deepSeekHarnessEndpoint === 'string'
        ? candidate.deepSeekHarnessEndpoint.trim()
        : DEFAULT_AGENT_SETTINGS.deepSeekHarnessEndpoint,
    deepSeekHarnessModel:
      typeof candidate.deepSeekHarnessModel === 'string' && candidate.deepSeekHarnessModel.trim()
        ? candidate.deepSeekHarnessModel.trim().slice(0, 160)
        : DEFAULT_AGENT_SETTINGS.deepSeekHarnessModel,
    deepSeekHarnessApiKey: '',
    localProviderDisclosureAccepted: candidate.localProviderDisclosureAccepted === true,
  };
}

function isLoopbackEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}
