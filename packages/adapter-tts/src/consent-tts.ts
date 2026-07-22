/**
 * TTS integration with consent checking (WP-05.5, §2.14, §29.9).
 *
 * Wraps TTS synthesis with consent validation. Consent must be checked BEFORE
 * synthesis, never after. If consent is denied, no synthesis occurs and no
 * audit entry is recorded.
 */

import type {
  CapabilityResult,
  ProviderV2,
  VoiceConsentManager,
  SynthesisAuditLog,
} from '@joy-media/provider-sdk';
import { attachVoiceMetadata } from '@joy-media/provider-sdk';

export interface TTSRequestWithConsent {
  readonly text: string;
  readonly voiceId?: string;
  readonly purpose: string;
  readonly userId: string;
}

export class VoiceConsentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VoiceConsentError';
    this.code = code;
  }
}

export async function synthesizeWithConsent(
  ttsAdapter: ProviderV2,
  consentManager: VoiceConsentManager,
  auditLog: SynthesisAuditLog,
  request: TTSRequestWithConsent,
): Promise<CapabilityResult> {
  if (!request.voiceId) {
    const result = await ttsAdapter.invoke('speech.synthesize', {
      text: request.text,
    });
    return result;
  }

  const voice = consentManager.getVoice(request.voiceId);
  if (!voice) {
    throw new VoiceConsentError(
      'VOICE_NOT_FOUND',
      `VOICE_NOT_FOUND: Voice "${request.voiceId}" not found`,
    );
  }

  const consentCheck = consentManager.canUseVoice(request.voiceId, {
    purpose: request.purpose,
    userId: request.userId,
  });

  if (!consentCheck.allowed) {
    throw new VoiceConsentError(
      'CONSENT_DENIED',
      `CONSENT_DENIED: Cannot use voice "${request.voiceId}": ${consentCheck.reason ?? 'consent denied'}`,
    );
  }

  const result = await ttsAdapter.invoke('speech.synthesize', {
    text: request.text,
    voiceId: request.voiceId,
  });

  if (result.status === 'succeeded' && result.outputs.length > 0) {
    const output = result.outputs[0]!;
    const resultWithMetadata = attachVoiceMetadata(result, voice, request.purpose);

    auditLog.record({
      voiceIdentityId: voice.id,
      voiceDisplayName: voice.displayName,
      capability: 'speech.synthesize',
      userId: request.userId,
      purpose: request.purpose,
      inputText: request.text,
      outputAssetId: output.assetId,
      providerId: result.provenance.providerId,
      modelId: result.provenance.modelId,
      consentRecordId: voice.consentRecordId,
    });

    return resultWithMetadata;
  }

  return result;
}
