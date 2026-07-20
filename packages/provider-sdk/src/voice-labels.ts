/**
 * Voice usage labeling (WP-05.5, §2.14, §29.9).
 *
 * Extracts voice usage information from capability results and generates
 * visible labels for UI display. Ensures cloned voice usage is transparent.
 */

import type { CapabilityResult } from './types.js';
import type { VoiceIdentity } from '@joy-media/project-schema';

export interface VoiceUsageLabel {
  readonly voiceIdentityId: string;
  readonly voiceDisplayName: string;
  readonly isCloned: boolean;
  readonly consentRecordId: string;
  readonly usedAt: string;
  readonly purpose: string;
}

export function extractVoiceUsage(result: CapabilityResult): VoiceUsageLabel | undefined {
  if (result.status !== 'succeeded') {
    return undefined;
  }

  for (const output of result.outputs) {
    if (output.metadata?.voiceIdentityId && output.metadata?.voiceDisplayName) {
      const metadata = output.metadata as Record<string, unknown>;
      return {
        voiceIdentityId: metadata.voiceIdentityId as string,
        voiceDisplayName: metadata.voiceDisplayName as string,
        isCloned: (metadata.isCloned as boolean) ?? false,
        consentRecordId: metadata.consentRecordId as string,
        usedAt: result.provenance.createdAt,
        purpose: (metadata.purpose as string) ?? 'unknown',
      };
    }
  }

  return undefined;
}

export function formatVoiceLabel(label: VoiceUsageLabel): string {
  const clonedIndicator = label.isCloned ? ' [CLONED]' : '';
  return `${label.voiceDisplayName}${clonedIndicator} — Consent: ${label.consentRecordId}`;
}

export function attachVoiceMetadata(
  result: CapabilityResult,
  voice: VoiceIdentity,
  purpose: string,
): CapabilityResult {
  const updatedOutputs = result.outputs.map((output) => ({
    ...output,
    metadata: {
      ...output.metadata,
      voiceIdentityId: voice.id,
      voiceDisplayName: voice.displayName,
      isCloned: true,
      consentRecordId: voice.consentRecordId,
      purpose,
    },
  }));

  return {
    ...result,
    outputs: updatedOutputs,
  };
}
