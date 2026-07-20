import { describe, expect, it } from 'vitest';
import { createTTSAdapter } from './index.js';
import { createVoiceConsentManager } from '@joy-media/provider-sdk';
import { createSynthesisAuditLog } from '@joy-media/provider-sdk';
import { synthesizeWithConsent, VoiceConsentError } from './consent-tts.js';

describe('TTS with Consent', () => {
  const createTestSetup = async () => {
    const ttsAdapter = createTTSAdapter({
      execution: 'worker-local',
      engine: 'kokoro',
    });
    const consentManager = createVoiceConsentManager();
    const auditLog = createSynthesisAuditLog();
    return { ttsAdapter, consentManager, auditLog };
  };

  describe('synthesizeWithConsent', () => {
    it('allows synthesis when consent is granted', async () => {
      const { ttsAdapter, consentManager, auditLog } = await createTestSetup();
      const voice = await consentManager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      const result = await synthesizeWithConsent(ttsAdapter, consentManager, auditLog, {
        text: 'Hello world',
        voiceId: voice.id,
        purpose: 'narration',
        userId: 'user-1',
      });

      expect(result.status).toBe('succeeded');
      expect(result.outputs).toHaveLength(1);
      expect(result.outputs[0]!.metadata!.voiceIdentityId).toBe(voice.id);
      expect(result.outputs[0]!.metadata!.voiceDisplayName).toBe('Test Voice');
      expect(result.outputs[0]!.metadata!.isCloned).toBe(true);
      expect(result.outputs[0]!.metadata!.consentRecordId).toBe(voice.consentRecordId);
      expect(result.outputs[0]!.metadata!.purpose).toBe('narration');

      const auditEntries = auditLog.getAllEntries();
      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0]!.voiceIdentityId).toBe(voice.id);
      expect(auditEntries[0]!.userId).toBe('user-1');
      expect(auditEntries[0]!.purpose).toBe('narration');
      expect(auditEntries[0]!.inputText).toBe('Hello world');
    });

    it('throws error when consent is denied', async () => {
      const { ttsAdapter, consentManager, auditLog } = await createTestSetup();
      const voice = await consentManager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      consentManager.revokeConsent(voice.consentRecordId, 'Owner withdrew consent');

      await expect(
        synthesizeWithConsent(ttsAdapter, consentManager, auditLog, {
          text: 'Hello world',
          voiceId: voice.id,
          purpose: 'narration',
          userId: 'user-1',
        }),
      ).rejects.toThrow(VoiceConsentError);

      await expect(
        synthesizeWithConsent(ttsAdapter, consentManager, auditLog, {
          text: 'Hello world',
          voiceId: voice.id,
          purpose: 'narration',
          userId: 'user-1',
        }),
      ).rejects.toThrow('CONSENT_DENIED');

      const auditEntries = auditLog.getAllEntries();
      expect(auditEntries).toHaveLength(0);
    });

    it('throws error when voice is suspended', async () => {
      const { ttsAdapter, consentManager, auditLog } = await createTestSetup();
      const voice = await consentManager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      consentManager.suspendVoice(voice.id, 'Under review');

      await expect(
        synthesizeWithConsent(ttsAdapter, consentManager, auditLog, {
          text: 'Hello world',
          voiceId: voice.id,
          purpose: 'narration',
          userId: 'user-1',
        }),
      ).rejects.toThrow(VoiceConsentError);

      const auditEntries = auditLog.getAllEntries();
      expect(auditEntries).toHaveLength(0);
    });

    it('throws error when voice is revoked', async () => {
      const { ttsAdapter, consentManager, auditLog } = await createTestSetup();
      const voice = await consentManager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      consentManager.revokeVoice(voice.id, 'Voice revoked');

      await expect(
        synthesizeWithConsent(ttsAdapter, consentManager, auditLog, {
          text: 'Hello world',
          voiceId: voice.id,
          purpose: 'narration',
          userId: 'user-1',
        }),
      ).rejects.toThrow(VoiceConsentError);

      const auditEntries = auditLog.getAllEntries();
      expect(auditEntries).toHaveLength(0);
    });

    it('throws error when voice is deleted', async () => {
      const { ttsAdapter, consentManager, auditLog } = await createTestSetup();
      const voice = await consentManager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      await consentManager.deleteVoice(voice.id);

      await expect(
        synthesizeWithConsent(ttsAdapter, consentManager, auditLog, {
          text: 'Hello world',
          voiceId: voice.id,
          purpose: 'narration',
          userId: 'user-1',
        }),
      ).rejects.toThrow(VoiceConsentError);

      const auditEntries = auditLog.getAllEntries();
      expect(auditEntries).toHaveLength(0);
    });

    it('throws error when voice not found', async () => {
      const { ttsAdapter, consentManager, auditLog } = await createTestSetup();

      await expect(
        synthesizeWithConsent(ttsAdapter, consentManager, auditLog, {
          text: 'Hello world',
          voiceId: 'non-existent',
          purpose: 'narration',
          userId: 'user-1',
        }),
      ).rejects.toThrow(VoiceConsentError);

      await expect(
        synthesizeWithConsent(ttsAdapter, consentManager, auditLog, {
          text: 'Hello world',
          voiceId: 'non-existent',
          purpose: 'narration',
          userId: 'user-1',
        }),
      ).rejects.toThrow('VOICE_NOT_FOUND');

      const auditEntries = auditLog.getAllEntries();
      expect(auditEntries).toHaveLength(0);
    });

    it('throws error when purpose not allowed', async () => {
      const { ttsAdapter, consentManager, auditLog } = await createTestSetup();
      const voice = await consentManager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      await expect(
        synthesizeWithConsent(ttsAdapter, consentManager, auditLog, {
          text: 'Hello world',
          voiceId: voice.id,
          purpose: 'demo',
          userId: 'user-1',
        }),
      ).rejects.toThrow(VoiceConsentError);

      const auditEntries = auditLog.getAllEntries();
      expect(auditEntries).toHaveLength(0);
    });

    it('throws error when user not authorized', async () => {
      const { ttsAdapter, consentManager, auditLog } = await createTestSetup();
      const voice = await consentManager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      await expect(
        synthesizeWithConsent(ttsAdapter, consentManager, auditLog, {
          text: 'Hello world',
          voiceId: voice.id,
          purpose: 'narration',
          userId: 'user-2',
        }),
      ).rejects.toThrow(VoiceConsentError);

      const auditEntries = auditLog.getAllEntries();
      expect(auditEntries).toHaveLength(0);
    });

    it('allows synthesis without voiceId (no consent check)', async () => {
      const { ttsAdapter, consentManager, auditLog } = await createTestSetup();

      const result = await synthesizeWithConsent(ttsAdapter, consentManager, auditLog, {
        text: 'Hello world',
        purpose: 'narration',
        userId: 'user-1',
      });

      expect(result.status).toBe('succeeded');
      expect(result.outputs).toHaveLength(1);

      const auditEntries = auditLog.getAllEntries();
      expect(auditEntries).toHaveLength(0);
    });

    it('CRITICAL: cloned voice cannot be used without active consent', async () => {
      const { ttsAdapter, consentManager, auditLog } = await createTestSetup();
      const voice = await consentManager.enrollVoice({
        displayName: 'Cloned Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      consentManager.revokeConsent(voice.consentRecordId, 'Owner withdrew consent');

      await expect(
        synthesizeWithConsent(ttsAdapter, consentManager, auditLog, {
          text: 'Hello world',
          voiceId: voice.id,
          purpose: 'narration',
          userId: 'user-1',
        }),
      ).rejects.toThrow(VoiceConsentError);

      const auditEntries = auditLog.getAllEntries();
      expect(auditEntries).toHaveLength(0);
    });
  });
});
