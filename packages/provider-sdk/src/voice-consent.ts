/**
 * Voice consent manager (WP-05.5, §2.14, §29.9).
 *
 * Manages voice identity enrollment, consent checking, and status transitions.
 * Consent must be explicit, checked BEFORE synthesis, and never inferred from
 * possession of audio files.
 */

import type {
  VoiceIdentity,
  VoiceStatus,
  ConsentRecord,
  ConsentCheckResult,
} from '@joy-media/project-schema';

export interface EnrollVoiceParams {
  readonly displayName: string;
  readonly ownerUserId?: string;
  readonly allowedPurposes: string[];
  readonly allowedUsersOrTeams: string[];
  readonly expiresAt?: string;
  readonly consentGrantedBy: string;
}

export interface VoiceConsentManager {
  enrollVoice(params: EnrollVoiceParams): Promise<VoiceIdentity>;
  getVoice(voiceId: string): VoiceIdentity | undefined;
  getAllVoices(): readonly VoiceIdentity[];
  getVoicesByOwner(userId: string): readonly VoiceIdentity[];
  getVoicesByStatus(status: VoiceStatus): readonly VoiceIdentity[];
  canUseVoice(
    voiceId: string,
    params: { purpose: string; userId: string; timestamp?: string },
  ): ConsentCheckResult;
  suspendVoice(voiceId: string, reason: string): void;
  revokeVoice(voiceId: string, reason: string): void;
  deleteVoice(voiceId: string): Promise<void>;
  restoreVoice(voiceId: string): void;
  getConsentRecord(consentId: string): ConsentRecord | undefined;
  getConsentRecordsForVoice(voiceId: string): readonly ConsentRecord[];
  revokeConsent(consentId: string, reason: string): void;
  syncDeletionToProvider(voiceId: string, providerId: string): Promise<void>;
}

let idCounter = 0;
function generateId(prefix: string): string {
  idCounter++;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

export function createVoiceConsentManager(): VoiceConsentManager {
  const voices = new Map<string, VoiceIdentity>();
  const consentRecords = new Map<string, ConsentRecord>();

  return {
    async enrollVoice(params: EnrollVoiceParams): Promise<VoiceIdentity> {
      const now = new Date().toISOString();
      const consentId = generateId('consent');
      const voiceId = generateId('voice');

      const consentRecord: ConsentRecord = {
        id: consentId,
        voiceIdentityId: voiceId,
        grantedBy: params.consentGrantedBy,
        grantedAt: now,
        ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
        purposes: [...params.allowedPurposes],
        revoked: false,
      };

      const voice: VoiceIdentity = {
        id: voiceId,
        displayName: params.displayName,
        ...(params.ownerUserId ? { ownerUserId: params.ownerUserId } : {}),
        consentRecordId: consentId,
        allowedPurposes: [...params.allowedPurposes],
        allowedUsersOrTeams: [...params.allowedUsersOrTeams],
        providerVoiceRefs: [],
        ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };

      voices.set(voiceId, voice);
      consentRecords.set(consentId, consentRecord);

      return voice;
    },

    getVoice(voiceId: string): VoiceIdentity | undefined {
      return voices.get(voiceId);
    },

    getAllVoices(): readonly VoiceIdentity[] {
      return Array.from(voices.values());
    },

    getVoicesByOwner(userId: string): readonly VoiceIdentity[] {
      return Array.from(voices.values()).filter((v) => v.ownerUserId === userId);
    },

    getVoicesByStatus(status: VoiceStatus): readonly VoiceIdentity[] {
      return Array.from(voices.values()).filter((v) => v.status === status);
    },

    canUseVoice(
      voiceId: string,
      params: { purpose: string; userId: string; timestamp?: string },
    ): ConsentCheckResult {
      const voice = voices.get(voiceId);
      if (!voice) {
        return { allowed: false, reason: 'Voice not found' };
      }

      if (voice.status === 'deleted') {
        return { allowed: false, reason: 'Voice has been deleted' };
      }

      if (voice.status === 'revoked') {
        return { allowed: false, reason: 'Voice has been revoked' };
      }

      if (voice.status === 'suspended') {
        return { allowed: false, reason: 'Voice is suspended' };
      }

      const consent = consentRecords.get(voice.consentRecordId);
      if (!consent) {
        return { allowed: false, reason: 'Consent record not found' };
      }

      if (consent.revoked) {
        return { allowed: false, reason: 'Consent has been revoked' };
      }

      const checkTime = params.timestamp ?? new Date().toISOString();
      if (consent.expiresAt && checkTime > consent.expiresAt) {
        return { allowed: false, reason: 'Consent has expired' };
      }

      if (voice.expiresAt && checkTime > voice.expiresAt) {
        return { allowed: false, reason: 'Voice identity has expired' };
      }

      if (!voice.allowedPurposes.includes(params.purpose)) {
        return {
          allowed: false,
          reason: `Purpose "${params.purpose}" not allowed for this voice`,
        };
      }

      if (!voice.allowedUsersOrTeams.includes(params.userId)) {
        return {
          allowed: false,
          reason: `User "${params.userId}" not authorized to use this voice`,
        };
      }

      return { allowed: true };
    },

    suspendVoice(voiceId: string, reason: string): void {
      const voice = voices.get(voiceId);
      if (!voice) {
        throw new Error(`Voice "${voiceId}" not found`);
      }
      if (voice.status === 'deleted') {
        throw new Error(`Cannot suspend deleted voice "${voiceId}"`);
      }

      const updated: VoiceIdentity = {
        ...voice,
        status: 'suspended',
        updatedAt: new Date().toISOString(),
        metadata: { ...voice.metadata, suspensionReason: reason },
      };
      voices.set(voiceId, updated);
    },

    revokeVoice(voiceId: string, reason: string): void {
      const voice = voices.get(voiceId);
      if (!voice) {
        throw new Error(`Voice "${voiceId}" not found`);
      }
      if (voice.status === 'deleted') {
        throw new Error(`Cannot revoke deleted voice "${voiceId}"`);
      }

      const now = new Date().toISOString();
      const updated: VoiceIdentity = {
        ...voice,
        status: 'revoked',
        updatedAt: now,
        metadata: { ...voice.metadata, revocationReason: reason },
      };
      voices.set(voiceId, updated);

      const consent = consentRecords.get(voice.consentRecordId);
      if (consent && !consent.revoked) {
        const updatedConsent: ConsentRecord = {
          ...consent,
          revoked: true,
          revokedAt: now,
          revocationReason: reason,
        };
        consentRecords.set(voice.consentRecordId, updatedConsent);
      }
    },

    async deleteVoice(voiceId: string): Promise<void> {
      const voice = voices.get(voiceId);
      if (!voice) {
        throw new Error(`Voice "${voiceId}" not found`);
      }

      const updated: VoiceIdentity = {
        ...voice,
        status: 'deleted',
        updatedAt: new Date().toISOString(),
      };
      voices.set(voiceId, updated);
    },

    restoreVoice(voiceId: string): void {
      const voice = voices.get(voiceId);
      if (!voice) {
        throw new Error(`Voice "${voiceId}" not found`);
      }
      if (voice.status !== 'revoked' && voice.status !== 'suspended') {
        throw new Error(`Cannot restore voice "${voiceId}" with status "${voice.status}"`);
      }

      const updated: VoiceIdentity = {
        ...voice,
        status: 'active',
        updatedAt: new Date().toISOString(),
      };
      voices.set(voiceId, updated);
    },

    getConsentRecord(consentId: string): ConsentRecord | undefined {
      return consentRecords.get(consentId);
    },

    getConsentRecordsForVoice(voiceId: string): readonly ConsentRecord[] {
      return Array.from(consentRecords.values()).filter((c) => c.voiceIdentityId === voiceId);
    },

    revokeConsent(consentId: string, reason: string): void {
      const consent = consentRecords.get(consentId);
      if (!consent) {
        throw new Error(`Consent record "${consentId}" not found`);
      }
      if (consent.revoked) {
        throw new Error(`Consent record "${consentId}" already revoked`);
      }

      const now = new Date().toISOString();
      const updated: ConsentRecord = {
        ...consent,
        revoked: true,
        revokedAt: now,
        revocationReason: reason,
      };
      consentRecords.set(consentId, updated);
    },

    async syncDeletionToProvider(voiceId: string, providerId: string): Promise<void> {
      const voice = voices.get(voiceId);
      if (!voice) {
        throw new Error(`Voice "${voiceId}" not found`);
      }
      if (voice.status !== 'deleted') {
        throw new Error(`Cannot sync non-deleted voice "${voiceId}" to provider`);
      }

      const providerRefs = voice.providerVoiceRefs.filter((ref) => ref.providerId === providerId);
      if (providerRefs.length === 0) {
        return;
      }

      // In a real implementation, this would call the provider's API to delete the voice
      // For now, we just log the intent
      console.log(
        `[VoiceConsentManager] Would sync deletion of voice "${voiceId}" to provider "${providerId}"`,
      );
    },
  };
}
