import { describe, expect, it } from 'vitest';
import { createVoiceConsentManager } from './voice-consent.js';

describe('VoiceConsentManager', () => {
  describe('enrollVoice', () => {
    it('creates voice identity with consent record', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        ownerUserId: 'user-1',
        allowedPurposes: ['narration', 'demo'],
        allowedUsersOrTeams: ['user-1', 'team-1'],
        consentGrantedBy: 'user-1',
      });

      expect(voice.id).toBeDefined();
      expect(voice.displayName).toBe('Test Voice');
      expect(voice.ownerUserId).toBe('user-1');
      expect(voice.status).toBe('active');
      expect(voice.allowedPurposes).toEqual(['narration', 'demo']);
      expect(voice.allowedUsersOrTeams).toEqual(['user-1', 'team-1']);
      expect(voice.consentRecordId).toBeDefined();

      const consent = manager.getConsentRecord(voice.consentRecordId);
      expect(consent).toBeDefined();
      expect(consent!.voiceIdentityId).toBe(voice.id);
      expect(consent!.grantedBy).toBe('user-1');
      expect(consent!.purposes).toEqual(['narration', 'demo']);
      expect(consent!.revoked).toBe(false);
    });

    it('creates voice with expiration', async () => {
      const manager = createVoiceConsentManager();
      const expiresAt = '2025-12-31T23:59:59.000Z';
      const voice = await manager.enrollVoice({
        displayName: 'Expiring Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        expiresAt,
        consentGrantedBy: 'user-1',
      });

      expect(voice.expiresAt).toBe(expiresAt);
      const consent = manager.getConsentRecord(voice.consentRecordId);
      expect(consent!.expiresAt).toBe(expiresAt);
    });
  });

  describe('canUseVoice', () => {
    it('allows use when all conditions are met', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      const result = manager.canUseVoice(voice.id, {
        purpose: 'narration',
        userId: 'user-1',
      });

      expect(result.allowed).toBe(true);
    });

    it('denies use when voice is not found', () => {
      const manager = createVoiceConsentManager();
      const result = manager.canUseVoice('non-existent', {
        purpose: 'narration',
        userId: 'user-1',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Voice not found');
    });

    it('denies use when voice is suspended', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      manager.suspendVoice(voice.id, 'Testing suspension');

      const result = manager.canUseVoice(voice.id, {
        purpose: 'narration',
        userId: 'user-1',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Voice is suspended');
    });

    it('denies use when voice is revoked', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      manager.revokeVoice(voice.id, 'Testing revocation');

      const result = manager.canUseVoice(voice.id, {
        purpose: 'narration',
        userId: 'user-1',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Voice has been revoked');
    });

    it('denies use when voice is deleted', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      await manager.deleteVoice(voice.id);

      const result = manager.canUseVoice(voice.id, {
        purpose: 'narration',
        userId: 'user-1',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Voice has been deleted');
    });

    it('denies use when consent is revoked', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      manager.revokeConsent(voice.consentRecordId, 'Testing consent revocation');

      const result = manager.canUseVoice(voice.id, {
        purpose: 'narration',
        userId: 'user-1',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Consent has been revoked');
    });

    it('denies use when consent has expired', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        expiresAt: '2020-01-01T00:00:00.000Z',
        consentGrantedBy: 'user-1',
      });

      const result = manager.canUseVoice(voice.id, {
        purpose: 'narration',
        userId: 'user-1',
        timestamp: '2025-01-01T00:00:00.000Z',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Consent has expired');
    });

    it('denies use when voice has expired', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        expiresAt: '2020-01-01T00:00:00.000Z',
        consentGrantedBy: 'user-1',
      });

      const result = manager.canUseVoice(voice.id, {
        purpose: 'narration',
        userId: 'user-1',
        timestamp: '2025-01-01T00:00:00.000Z',
      });

      expect(result.allowed).toBe(false);
    });

    it('denies use for wrong purpose', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      const result = manager.canUseVoice(voice.id, {
        purpose: 'demo',
        userId: 'user-1',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Purpose "demo" not allowed');
    });

    it('denies use for wrong user', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      const result = manager.canUseVoice(voice.id, {
        purpose: 'narration',
        userId: 'user-2',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('User "user-2" not authorized');
    });
  });

  describe('CRITICAL: cloned voice cannot be used without active consent', () => {
    it('blocks synthesis when consent is revoked', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Cloned Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      manager.revokeConsent(voice.consentRecordId, 'Owner withdrew consent');

      const result = manager.canUseVoice(voice.id, {
        purpose: 'narration',
        userId: 'user-1',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Consent has been revoked');
    });

    it('blocks synthesis when voice is suspended', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Cloned Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      manager.suspendVoice(voice.id, 'Under review');

      const result = manager.canUseVoice(voice.id, {
        purpose: 'narration',
        userId: 'user-1',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Voice is suspended');
    });

    it('blocks synthesis when voice is deleted', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Cloned Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      await manager.deleteVoice(voice.id);

      const result = manager.canUseVoice(voice.id, {
        purpose: 'narration',
        userId: 'user-1',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Voice has been deleted');
    });
  });

  describe('status transitions', () => {
    it('transitions from active to suspended', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      manager.suspendVoice(voice.id, 'Testing');

      const updated = manager.getVoice(voice.id);
      expect(updated!.status).toBe('suspended');
    });

    it('transitions from suspended to active (restore)', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      manager.suspendVoice(voice.id, 'Testing');
      manager.restoreVoice(voice.id);

      const updated = manager.getVoice(voice.id);
      expect(updated!.status).toBe('active');
    });

    it('transitions from active to revoked', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      manager.revokeVoice(voice.id, 'Testing');

      const updated = manager.getVoice(voice.id);
      expect(updated!.status).toBe('revoked');
    });

    it('transitions from revoked to active (restore)', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      manager.revokeVoice(voice.id, 'Testing');
      manager.restoreVoice(voice.id);

      const updated = manager.getVoice(voice.id);
      expect(updated!.status).toBe('active');
    });

    it('transitions to deleted', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      await manager.deleteVoice(voice.id);

      const updated = manager.getVoice(voice.id);
      expect(updated!.status).toBe('deleted');
    });
  });

  describe('query methods', () => {
    it('getAllVoices returns all voices', async () => {
      const manager = createVoiceConsentManager();
      await manager.enrollVoice({
        displayName: 'Voice 1',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });
      await manager.enrollVoice({
        displayName: 'Voice 2',
        allowedPurposes: ['demo'],
        allowedUsersOrTeams: ['user-2'],
        consentGrantedBy: 'user-2',
      });

      const voices = manager.getAllVoices();
      expect(voices).toHaveLength(2);
    });

    it('getVoicesByOwner filters by owner', async () => {
      const manager = createVoiceConsentManager();
      await manager.enrollVoice({
        displayName: 'Voice 1',
        ownerUserId: 'user-1',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });
      await manager.enrollVoice({
        displayName: 'Voice 2',
        ownerUserId: 'user-2',
        allowedPurposes: ['demo'],
        allowedUsersOrTeams: ['user-2'],
        consentGrantedBy: 'user-2',
      });

      const voices = manager.getVoicesByOwner('user-1');
      expect(voices).toHaveLength(1);
      expect(voices[0]!.displayName).toBe('Voice 1');
    });

    it('getVoicesByStatus filters by status', async () => {
      const manager = createVoiceConsentManager();
      await manager.enrollVoice({
        displayName: 'Voice 1',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });
      const voice2 = await manager.enrollVoice({
        displayName: 'Voice 2',
        allowedPurposes: ['demo'],
        allowedUsersOrTeams: ['user-2'],
        consentGrantedBy: 'user-2',
      });

      manager.suspendVoice(voice2.id, 'Testing');

      const activeVoices = manager.getVoicesByStatus('active');
      expect(activeVoices).toHaveLength(1);
      expect(activeVoices[0]!.displayName).toBe('Voice 1');

      const suspendedVoices = manager.getVoicesByStatus('suspended');
      expect(suspendedVoices).toHaveLength(1);
      expect(suspendedVoices[0]!.displayName).toBe('Voice 2');
    });

    it('getConsentRecordsForVoice returns all consent records for a voice', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      const records = manager.getConsentRecordsForVoice(voice.id);
      expect(records).toHaveLength(1);
      expect(records[0]!.id).toBe(voice.consentRecordId);
    });
  });

  describe('consent revocation', () => {
    it('updates consent record when revoked', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      manager.revokeConsent(voice.consentRecordId, 'Owner withdrew consent');

      const consent = manager.getConsentRecord(voice.consentRecordId);
      expect(consent!.revoked).toBe(true);
      expect(consent!.revokedAt).toBeDefined();
      expect(consent!.revocationReason).toBe('Owner withdrew consent');
    });

    it('throws when revoking already revoked consent', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      manager.revokeConsent(voice.consentRecordId, 'First revocation');

      expect(() => {
        manager.revokeConsent(voice.consentRecordId, 'Second revocation');
      }).toThrow('already revoked');
    });
  });

  describe('provider synchronization', () => {
    it('attempts to sync deletion to provider', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      await manager.deleteVoice(voice.id);

      await expect(
        manager.syncDeletionToProvider(voice.id, 'test-provider'),
      ).resolves.not.toThrow();
    });

    it('throws when syncing non-deleted voice', async () => {
      const manager = createVoiceConsentManager();
      const voice = await manager.enrollVoice({
        displayName: 'Test Voice',
        allowedPurposes: ['narration'],
        allowedUsersOrTeams: ['user-1'],
        consentGrantedBy: 'user-1',
      });

      await expect(manager.syncDeletionToProvider(voice.id, 'test-provider')).rejects.toThrow(
        'Cannot sync non-deleted voice',
      );
    });
  });
});
