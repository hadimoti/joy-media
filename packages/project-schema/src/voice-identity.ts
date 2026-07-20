/**
 * Voice identity and consent models (WP-05.5, §2.14, §29.9).
 *
 * Voice cloning requires explicit consent controls. This is a product
 * requirement, not optional legal garnish. Consent must be checked BEFORE
 * synthesis, never inferred from possession of an audio file.
 */

export type VoiceStatus = 'active' | 'suspended' | 'revoked' | 'deleted';

export interface ProviderVoiceRef {
  readonly handleId: string;
  readonly providerId: string;
  readonly fieldName: string;
}

export interface VoiceIdentity {
  readonly id: string;
  readonly displayName: string;
  readonly ownerUserId?: string;
  readonly consentRecordId: string;
  readonly allowedPurposes: readonly string[];
  readonly allowedUsersOrTeams: readonly string[];
  readonly providerVoiceRefs: readonly ProviderVoiceRef[];
  readonly expiresAt?: string;
  readonly status: VoiceStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ConsentRecord {
  readonly id: string;
  readonly voiceIdentityId: string;
  readonly grantedBy: string;
  readonly grantedAt: string;
  readonly expiresAt?: string;
  readonly purposes: readonly string[];
  readonly restrictions?: string;
  readonly revoked: boolean;
  readonly revokedAt?: string;
  readonly revocationReason?: string;
}

export interface ConsentCheckResult {
  readonly allowed: boolean;
  readonly reason?: string;
}
