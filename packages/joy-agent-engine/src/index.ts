/** Stable package identity used in diagnostics and release checks. */
export const PACKAGE_NAME = '@joy-media/joy-agent-engine' as const;

export type {
  JoyAgentErrorDetail,
  JoyAgentActivityEvent,
  JoyAgentCapabilityEvent,
  JoyAgentCancelledEvent,
  JoyAgentCompletedEvent,
  JoyAgentEventBase,
  JoyAgentFailedEvent,
  JoyAgentPhase,
  JoyAgentProposalEvent,
  JoyAgentRunRequest,
  JoyAgentSafeError,
  JoyAgentSafeEvent,
  JoyAgentSurface,
  JoyAgentTaskKind,
  JoyAgentTextDeltaEvent,
  JoyAgentToolRequestEvent,
  JoyAgentUsageEvent,
} from './contracts.js';
export {
  JOY_AGENT_CAPABILITIES,
  JOY_AGENT_ERROR_CODES,
  JOY_AGENT_PHASES,
  JOY_AGENT_PROTOCOL_VERSION,
  JOY_AGENT_SURFACES,
  JOY_AGENT_TASK_KINDS,
  isJoyAgentSafeEvent,
  parseJoyAgentSafeEvent,
} from './contracts.js';
export type { JoyAgentLimits } from './limits.js';
export { DEFAULT_JOY_AGENT_LIMITS, clampJoyAgentLimits } from './limits.js';
export {
  redactUnknownValue,
  classifyJoyAgentError,
  isJoyAgentErrorCode,
  toSafeJoyAgentError,
} from './redaction.js';
export { JoyAgentRunError } from './engine.js';
export type { ByokSessionConfig, ByokSessionStatus } from './provider-config.js';
export {
  ProviderConfigError,
  normalizeByokSessionConfig,
  normalizeCustomBaseUrl,
  safeByokSessionStatus,
} from './provider-config.js';
export {
  DEFAULT_KILO_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_JOY_HOSTED_MODEL,
  JOY_HOSTED_BASE_URL,
  KILO_GATEWAY_BASE_URL,
  KILO_MODEL_PRESETS,
  LEGACY_KILO_BASE_URLS,
  OPENROUTER_BASE_URL,
  RETIRED_MODEL_IDS,
  canonicalKiloBaseUrl,
  defaultModelFor,
  isRetiredModelId,
} from './provider-presets.js';
export type { ProviderModelPreset } from './provider-presets.js';
export type { JoyFetch } from './provider.js';
export {
  DEFAULT_PROVIDER_RESPONSE_BYTES,
  createHardenedFetch,
  createJoyAgentProvider,
} from './provider.js';
export type {
  JoyAgentToolBridge,
  JoyAgentToolMetadata,
  JoyAgentToolName,
  JoyDocumentOperation,
  JoyPlanChecklistItem,
  JoyTimelineOperation,
} from './tools.js';
export {
  JOY_LOOK_PRESETS,
  normalizeDocumentOperationAliases,
  normalizeLookName,
  normalizeTimelineOperationAliases,
  pickAlias,
  resolveLookAliases,
  type AliasEntry,
  type JoyLookPreset,
} from './aliases.js';
export {
  JOY_AGENT_TOOL_METADATA,
  createJoyAgentTools,
  parseJoyDocumentOperations,
  parseJoyTimelineOperations,
  validateOperationDependencies,
} from './tools.js';
export {
  JOY_AGENT_INSTRUCTIONS,
  JoyAgentEngine,
  probeJoyAgentModel,
  type JoyAgentEngineOptions,
  type JoyAgentProbeResult,
  type JoyAgentRunResult,
  type JoyAgentTraceRecord,
} from './engine.js';
