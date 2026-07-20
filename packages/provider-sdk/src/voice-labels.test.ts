import { describe, expect, it } from 'vitest';
import type { CapabilityResult } from './types.js';
import { extractVoiceUsage, formatVoiceLabel, attachVoiceMetadata } from './voice-labels.js';

function makeResult(overrides: Partial<CapabilityResult> = {}): CapabilityResult {
  return {
    requestId: 'req-1',
    status: 'succeeded',
    outputs: [
      {
        kind: 'audio',
        assetId: 'asset-1',
        mimeType: 'audio/wav',
        metadata: {
          voiceIdentityId: 'voice-1',
          voiceDisplayName: 'Test Voice',
          isCloned: true,
          consentRecordId: 'consent-1',
          purpose: 'narration',
        },
      },
    ],
    provenance: {
      providerId: 'joy.tts-kokoro',
      modelId: 'kokoro',
      adapterVersion: '1.0.0',
      createdAt: '2025-01-01T00:00:00.000Z',
      requestHash: 'hash-1',
      idempotencyKey: 'key-1',
      processingTimeMs: 100,
      execution: 'worker-local',
    },
    diagnostics: [],
    ...overrides,
  };
}

describe('Voice Labels', () => {
  describe('extractVoiceUsage', () => {
    it('extracts voice usage from capability result', () => {
      const result = makeResult();
      const label = extractVoiceUsage(result);

      expect(label).toBeDefined();
      expect(label!.voiceIdentityId).toBe('voice-1');
      expect(label!.voiceDisplayName).toBe('Test Voice');
      expect(label!.isCloned).toBe(true);
      expect(label!.consentRecordId).toBe('consent-1');
      expect(label!.purpose).toBe('narration');
      expect(label!.usedAt).toBe('2025-01-01T00:00:00.000Z');
    });

    it('returns undefined for failed results', () => {
      const result = makeResult({ status: 'failed', outputs: [] });
      const label = extractVoiceUsage(result);
      expect(label).toBeUndefined();
    });

    it('returns undefined when no voice metadata present', () => {
      const result = makeResult({
        outputs: [{ kind: 'audio', assetId: 'asset-1', mimeType: 'audio/wav' }],
      });
      const label = extractVoiceUsage(result);
      expect(label).toBeUndefined();
    });
  });

  describe('formatVoiceLabel', () => {
    it('formats cloned voice label with indicator', () => {
      const label = {
        voiceIdentityId: 'voice-1',
        voiceDisplayName: 'Test Voice',
        isCloned: true,
        consentRecordId: 'consent-1',
        usedAt: '2025-01-01T00:00:00.000Z',
        purpose: 'narration',
      };
      const formatted = formatVoiceLabel(label);
      expect(formatted).toContain('[CLONED]');
      expect(formatted).toContain('Test Voice');
      expect(formatted).toContain('consent-1');
    });

    it('formats non-cloned voice label without indicator', () => {
      const label = {
        voiceIdentityId: 'voice-1',
        voiceDisplayName: 'Default Voice',
        isCloned: false,
        consentRecordId: 'consent-1',
        usedAt: '2025-01-01T00:00:00.000Z',
        purpose: 'narration',
      };
      const formatted = formatVoiceLabel(label);
      expect(formatted).not.toContain('[CLONED]');
      expect(formatted).toContain('Default Voice');
    });
  });

  describe('attachVoiceMetadata', () => {
    it('attaches voice metadata to capability result', () => {
      const result = makeResult({
        outputs: [{ kind: 'audio', assetId: 'asset-1', mimeType: 'audio/wav' }],
      });
      const voice = {
        id: 'voice-1',
        displayName: 'Test Voice',
        consentRecordId: 'consent-1',
        allowedPurposes: ['narration'] as const,
        allowedUsersOrTeams: ['user-1'] as const,
        providerVoiceRefs: [] as const,
        status: 'active' as const,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      };

      const updated = attachVoiceMetadata(result, voice, 'narration');

      expect(updated.outputs[0]!.metadata!.voiceIdentityId).toBe('voice-1');
      expect(updated.outputs[0]!.metadata!.voiceDisplayName).toBe('Test Voice');
      expect(updated.outputs[0]!.metadata!.isCloned).toBe(true);
      expect(updated.outputs[0]!.metadata!.consentRecordId).toBe('consent-1');
      expect(updated.outputs[0]!.metadata!.purpose).toBe('narration');
    });
  });
});
