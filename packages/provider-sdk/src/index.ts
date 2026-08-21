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
  ProviderScoreDimensionNameV1,
  ProviderScoreDimensionV1,
  ProviderScoreBreakdownV1,
  ProviderCandidateGateV1,
  ProviderCandidateGateResultV1,
  ProviderCandidateDecisionV1,
  ProviderDecisionV1,
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
export { resolveProvider, resolveProviderDecision } from './resolution.js';
export type { ProviderDecisionOptions } from './decision.js';
export { decideProvider } from './decision.js';
export type {
  ProviderBudgetLedgerV1,
  ProviderBudgetReservationV1,
  ProviderBudgetReconciliationV1,
  ReserveProviderBudgetInput,
  ReconcileProviderBudgetInput,
  ReserveProviderBudgetResult,
  ReconcileProviderBudgetResult,
} from './budget.js';
export {
  createProviderBudgetLedger,
  reserveProviderBudget,
  reconcileProviderBudget,
} from './budget.js';
export { ProviderLifecycle } from './lifecycle.js';
export {
  computePrivacyPreflight,
  computeProviderApprovalPreflight,
  computeProviderRequestDigest,
} from './privacy.js';
export type {
  ProviderApprovalBinding,
  ProviderApprovalGrant,
  ProviderApprovalPreflight,
} from './privacy.js';
export { createMemorySecretStore } from './secrets.js';
export type { AgentHostManifestValidation } from './agent-host.js';
export { validateAgentHostManifest } from './agent-host.js';
export { aggregateUsage, linkUsageToProviderDecision } from './provenance.js';
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
