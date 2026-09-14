import type { CaptionDocumentV1 } from '@joy-media/project-schema';
import type { Provider, TranscriptionResult } from './types.js';
import { ProviderUnavailableError } from './errors.js';

// Re-export all types
export type {
  // V1 types
  ProviderManifest,
  TranscriptionWord,
  TranscriptionResult,
  Provider,
  // V2 types
  JsonSchema,
  CapabilityId,
  ModelDescriptor,
  ResourceEstimate,
  PricingDescriptor,
  ProviderHealthSpec,
  Money,
  CapabilityDeclaration,
  ProviderManifestV2,
  ProviderV2,
  AnyProvider,
  // Request types
  CapabilityRequest,
  ProviderPolicy,
  ProviderResolution,
  // Lifecycle types
  ProviderLifecycleState,
  ProviderStatus,
  // Privacy types
  PrivacyPreflight,
  // Secret types
  SecretHandle,
  SecretStore,
  ServerSecretReference,
  ReasoningModelReference,
  MediaProviderReference,
  LocalExecutorReference,
  AgentHostToolDescriptor,
  AgentHostManifest,
  // Provenance types
  GenerationProvenance,
  ProviderUsage,
  UsageRecord,
  // Result types
  CapabilityResult,
  GeneratedOutput,
  Diagnostic,
} from './types.js';

// Re-export error
export { ProviderUnavailableError } from './errors.js';

// Re-export implementations
export { resolveProvider } from './resolution.js';
export { ProviderLifecycle } from './lifecycle.js';
export { computePrivacyPreflight } from './privacy.js';
export { createMemorySecretStore } from './secrets.js';
export type { AgentHostManifestValidation } from './agent-host.js';
export { validateAgentHostManifest } from './agent-host.js';
export { aggregateUsage } from './provenance.js';
export {
  createMockProvider,
  validateManifest,
  createTestRequest,
  assertResultSucceeded,
  simulateProviderFailure,
} from './testing.js';

// Re-export utilities
export {
  isV2Provider,
  getProviderId,
  getCapabilityIds,
  supportsCapability,
  getExecution,
  getDataLeavesDevice,
  getAdapterVersion,
  getModelVersions,
  getCapabilityDeclaration,
  isLocalExecution,
  isRemoteExecution,
  compareMoney,
  addMoney,
} from './utils.js';

// Re-export voice consent (WP-05.5)
export type { VoiceConsentManager, EnrollVoiceParams } from './voice-consent.js';
export { createVoiceConsentManager } from './voice-consent.js';

// Re-export voice labels (WP-05.5)
export type { VoiceUsageLabel } from './voice-labels.js';
export { extractVoiceUsage, formatVoiceLabel, attachVoiceMetadata } from './voice-labels.js';

// Re-export synthesis audit (WP-05.5)
export type { SynthesisAuditLog, SynthesisAuditEntry } from './synthesis-audit.js';
export { createSynthesisAuditLog } from './synthesis-audit.js';

// Re-export BYOK provider-profile validation (JOY Media desktop migration, wave 3)
export type { ByokProvider, ProviderProfileInput, ValidationIssue } from './validation.js';
export { BYOK_PROVIDERS, validateProviderProfileInput } from './validation.js';

// Re-export the direct-provider capability probe adapter (wave 3)
export type {
  DirectProviderErrorCode,
  DirectProviderProbeRequest,
  DirectProviderProbeReport,
  FetchLike,
  FetchResponseLike,
} from './adapters/openai-compatible.js';
export { probeOpenAiCompatibleProvider } from './adapters/openai-compatible.js';

// ===== V1 Backward Compatibility =====

export function createLocalWhisperProvider(
  execute: Provider['invoke'],
  modelId = 'whisper-local',
): Provider {
  return {
    manifest: { id: 'joy.local-whisper', version: 1, capabilities: ['speech.transcribe'] },
    invoke: async (capability, input) => {
      try {
        const result = await execute(capability, input);
        return {
          ...result,
          provenance: { ...result.provenance, providerId: 'joy.local-whisper', modelId },
        };
      } catch (error) {
        throw new ProviderUnavailableError(
          `local Whisper runtime unavailable: ${(error as Error).message}`,
        );
      }
    },
  };
}

export function captionDocumentFromTranscription(
  id: string,
  result: TranscriptionResult,
): CaptionDocumentV1 {
  const words = Object.fromEntries(
    result.words.map((word, index) => [`word-${index}`, { id: `word-${index}`, ...word }]),
  );
  return {
    id,
    language: result.language,
    direction: 'auto',
    speakers: result.speakers ?? [],
    words,
    segments:
      result.words.length === 0
        ? []
        : [
            {
              id: 'segment-0',
              startUs: result.words[0]!.startUs,
              endUs: result.words.at(-1)!.endUs,
              wordIds: result.words.map((_, index) => `word-${index}`),
            },
          ],
    provenance: result.provenance,
  };
}
