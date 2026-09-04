/** Stable package identity used in diagnostics and release checks. */
export const PACKAGE_NAME = '@joy-media/joy-agent-engine' as const;

export type {
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
export type { ByokSessionConfig, ByokSessionStatus } from './provider-config.js';
export {
  OPENROUTER_BASE_URL,
  ProviderConfigError,
  normalizeByokSessionConfig,
  normalizeCustomBaseUrl,
  safeByokSessionStatus,
} from './provider-config.js';
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
  JoyTimelineOperation,
} from './tools.js';
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
} from './engine.js';
