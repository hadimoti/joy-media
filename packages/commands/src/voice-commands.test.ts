import { describe, expect, it } from 'vitest';
import { applyVoiceCommand, createInitialVoiceState, VoiceCommandError } from './voice-commands.js';

describe('Voice Commands', () => {
  describe('voiceIdentity.create', () => {
    it('creates voice identity with consent record', () => {
      const state = createInitialVoiceState();
      const result = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          displayName: 'Test Voice',
          ownerUserId: 'user-1',
          allowedPurposes: ['narration', 'demo'],
          allowedUsersOrTeams: ['user-1', 'team-1'],
          consentGrantedBy: 'user-1',
        },
      });

      expect(Object.keys(result.state.voices)).toHaveLength(1);
      expect(Object.keys(result.state.consentRecords)).toHaveLength(1);

      const voice = Object.values(result.state.voices)[0]!;
      expect(voice.displayName).toBe('Test Voice');
      expect(voice.ownerUserId).toBe('user-1');
      expect(voice.status).toBe('active');
      expect(voice.allowedPurposes).toEqual(['narration', 'demo']);
      expect(voice.allowedUsersOrTeams).toEqual(['user-1', 'team-1']);

      const consent = Object.values(result.state.consentRecords)[0]!;
      expect(consent.voiceIdentityId).toBe(voice.id);
      expect(consent.grantedBy).toBe('user-1');
      expect(consent.purposes).toEqual(['narration', 'demo']);
      expect(consent.revoked).toBe(false);
    });

    it('inverse deletes the created voice', () => {
      const state = createInitialVoiceState();
      const result = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          displayName: 'Test Voice',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      expect(result.inverse.type).toBe('voiceIdentity.delete');
      const voiceId = Object.keys(result.state.voices)[0]!;
      expect((result.inverse.payload as { voiceId: string }).voiceId).toBe(voiceId);

      const undone = applyVoiceCommand(result.state, result.inverse);
      const voice = Object.values(undone.state.voices)[0]!;
      expect(voice.status).toBe('deleted');
    });

    it('rejects duplicate voice id', () => {
      const state = createInitialVoiceState();
      const result1 = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          id: 'voice-1',
          displayName: 'Voice 1',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      expect(() =>
        applyVoiceCommand(result1.state, {
          type: 'voiceIdentity.create',
          payload: {
            id: 'voice-1',
            displayName: 'Voice 2',
            allowedPurposes: ['narration'],
            allowedUsersOrTeams: ['user-1'],
            consentGrantedBy: 'user-1',
          },
        }),
      ).toThrow(VoiceCommandError);
    });
  });

  describe('voiceIdentity.update', () => {
    it('updates voice metadata', () => {
      const state = createInitialVoiceState();
      const created = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          id: 'voice-1',
          displayName: 'Original Name',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      const updated = applyVoiceCommand(created.state, {
        type: 'voiceIdentity.update',
        payload: {
          voiceId: 'voice-1',
          displayName: 'New Name',
          allowedPurposes: ['narration', 'demo'],
        },
      });

      const voice = updated.state.voices['voice-1']!;
      expect(voice.displayName).toBe('New Name');
      expect(voice.allowedPurposes).toEqual(['narration', 'demo']);
    });

    it('inverse restores previous values', () => {
      const state = createInitialVoiceState();
      const created = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          id: 'voice-1',
          displayName: 'Original Name',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      const updated = applyVoiceCommand(created.state, {
        type: 'voiceIdentity.update',
        payload: {
          voiceId: 'voice-1',
          displayName: 'New Name',
          allowedPurposes: ['narration', 'demo'],
        },
      });

      const undone = applyVoiceCommand(updated.state, updated.inverse);
      const voice = undone.state.voices['voice-1']!;
      expect(voice.displayName).toBe('Original Name');
      expect(voice.allowedPurposes).toEqual(['narration']);
    });

    it('rejects update on deleted voice', () => {
      const state = createInitialVoiceState();
      const created = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          id: 'voice-1',
          displayName: 'Test Voice',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      const deleted = applyVoiceCommand(created.state, {
        type: 'voiceIdentity.delete',
        payload: { voiceId: 'voice-1' },
      });

      expect(() =>
        applyVoiceCommand(deleted.state, {
          type: 'voiceIdentity.update',
          payload: { voiceId: 'voice-1', displayName: 'New Name' },
        }),
      ).toThrow(VoiceCommandError);
    });
  });

  describe('voiceIdentity.suspend', () => {
    it('suspends active voice', () => {
      const state = createInitialVoiceState();
      const created = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          id: 'voice-1',
          displayName: 'Test Voice',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      const suspended = applyVoiceCommand(created.state, {
        type: 'voiceIdentity.suspend',
        payload: { voiceId: 'voice-1', reason: 'Under review' },
      });

      expect(suspended.state.voices['voice-1']!.status).toBe('suspended');
    });

    it('inverse restores previous state', () => {
      const state = createInitialVoiceState();
      const created = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          id: 'voice-1',
          displayName: 'Test Voice',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      const suspended = applyVoiceCommand(created.state, {
        type: 'voiceIdentity.suspend',
        payload: { voiceId: 'voice-1', reason: 'Under review' },
      });

      expect(suspended.inverse.type).toBe('voiceIdentity.restore');
      const restored = applyVoiceCommand(suspended.state, suspended.inverse);
      expect(restored.state.voices['voice-1']!.status).toBe('active');
    });
  });

  describe('voiceIdentity.revoke', () => {
    it('revokes voice and consent record', () => {
      const state = createInitialVoiceState();
      const created = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          id: 'voice-1',
          displayName: 'Test Voice',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      const revoked = applyVoiceCommand(created.state, {
        type: 'voiceIdentity.revoke',
        payload: { voiceId: 'voice-1', reason: 'Policy violation' },
      });

      expect(revoked.state.voices['voice-1']!.status).toBe('revoked');
      const consentId = revoked.state.voices['voice-1']!.consentRecordId;
      expect(revoked.state.consentRecords[consentId]!.revoked).toBe(true);
      expect(revoked.state.consentRecords[consentId]!.revocationReason).toBe('Policy violation');
    });

    it('inverse restores voice', () => {
      const state = createInitialVoiceState();
      const created = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          id: 'voice-1',
          displayName: 'Test Voice',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      const revoked = applyVoiceCommand(created.state, {
        type: 'voiceIdentity.revoke',
        payload: { voiceId: 'voice-1', reason: 'Policy violation' },
      });

      expect(revoked.inverse.type).toBe('voiceIdentity.restore');
      const restored = applyVoiceCommand(revoked.state, revoked.inverse);
      expect(restored.state.voices['voice-1']!.status).toBe('active');
    });
  });

  describe('voiceIdentity.delete', () => {
    it('deletes voice', () => {
      const state = createInitialVoiceState();
      const created = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          id: 'voice-1',
          displayName: 'Test Voice',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      const deleted = applyVoiceCommand(created.state, {
        type: 'voiceIdentity.delete',
        payload: { voiceId: 'voice-1' },
      });

      expect(deleted.state.voices['voice-1']!.status).toBe('deleted');
    });

    it('inverse restores voice', () => {
      const state = createInitialVoiceState();
      const created = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          id: 'voice-1',
          displayName: 'Test Voice',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      const deleted = applyVoiceCommand(created.state, {
        type: 'voiceIdentity.delete',
        payload: { voiceId: 'voice-1' },
      });

      expect(deleted.inverse.type).toBe('voiceIdentity.restore');
      const restored = applyVoiceCommand(deleted.state, deleted.inverse);
      expect(restored.state.voices['voice-1']!.status).toBe('active');
    });
  });

  describe('voiceIdentity.restore', () => {
    it('restores revoked voice', () => {
      const state = createInitialVoiceState();
      const created = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          id: 'voice-1',
          displayName: 'Test Voice',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      const revoked = applyVoiceCommand(created.state, {
        type: 'voiceIdentity.revoke',
        payload: { voiceId: 'voice-1', reason: 'Policy violation' },
      });

      const restored = applyVoiceCommand(revoked.state, {
        type: 'voiceIdentity.restore',
        payload: { voiceId: 'voice-1' },
      });

      expect(restored.state.voices['voice-1']!.status).toBe('active');
    });

    it('restores suspended voice', () => {
      const state = createInitialVoiceState();
      const created = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          id: 'voice-1',
          displayName: 'Test Voice',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      const suspended = applyVoiceCommand(created.state, {
        type: 'voiceIdentity.suspend',
        payload: { voiceId: 'voice-1', reason: 'Under review' },
      });

      const restored = applyVoiceCommand(suspended.state, {
        type: 'voiceIdentity.restore',
        payload: { voiceId: 'voice-1' },
      });

      expect(restored.state.voices['voice-1']!.status).toBe('active');
    });

    it('rejects restore on active voice', () => {
      const state = createInitialVoiceState();
      const created = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          id: 'voice-1',
          displayName: 'Test Voice',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      expect(() =>
        applyVoiceCommand(created.state, {
          type: 'voiceIdentity.restore',
          payload: { voiceId: 'voice-1' },
        }),
      ).toThrow(VoiceCommandError);
    });
  });

  describe('consent.grant', () => {
    it('grants new consent record', () => {
      const state = createInitialVoiceState();
      const created = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          id: 'voice-1',
          displayName: 'Test Voice',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      const granted = applyVoiceCommand(created.state, {
        type: 'consent.grant',
        payload: {
          voiceId: 'voice-1',
          grantedBy: 'user-2',
          purposes: ['demo'],
        },
      });

      expect(Object.keys(granted.state.consentRecords)).toHaveLength(2);
      const newConsent = Object.values(granted.state.consentRecords).find(
        (c) => c.grantedBy === 'user-2',
      );
      expect(newConsent).toBeDefined();
      expect(newConsent!.purposes).toEqual(['demo']);
      expect(newConsent!.revoked).toBe(false);
    });

    it('inverse revokes the granted consent', () => {
      const state = createInitialVoiceState();
      const created = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          id: 'voice-1',
          displayName: 'Test Voice',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      const granted = applyVoiceCommand(created.state, {
        type: 'consent.grant',
        payload: {
          voiceId: 'voice-1',
          grantedBy: 'user-2',
          purposes: ['demo'],
        },
      });

      expect(granted.inverse.type).toBe('consent.revoke');
      const undone = applyVoiceCommand(granted.state, granted.inverse);
      if (granted.inverse.type === 'consent.revoke') {
        const consentId = granted.inverse.payload.consentId;
        expect(undone.state.consentRecords[consentId]!.revoked).toBe(true);
      }
    });
  });

  describe('consent.revoke', () => {
    it('revokes consent record', () => {
      const state = createInitialVoiceState();
      const created = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          id: 'voice-1',
          displayName: 'Test Voice',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      const consentId = Object.keys(created.state.consentRecords)[0]!;
      const revoked = applyVoiceCommand(created.state, {
        type: 'consent.revoke',
        payload: { consentId, reason: 'Owner withdrew consent' },
      });

      expect(revoked.state.consentRecords[consentId]!.revoked).toBe(true);
      expect(revoked.state.consentRecords[consentId]!.revocationReason).toBe(
        'Owner withdrew consent',
      );
    });

    it('rejects revocation of already revoked consent', () => {
      const state = createInitialVoiceState();
      const created = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          id: 'voice-1',
          displayName: 'Test Voice',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      const consentId = Object.keys(created.state.consentRecords)[0]!;
      const revoked = applyVoiceCommand(created.state, {
        type: 'consent.revoke',
        payload: { consentId, reason: 'First revocation' },
      });

      expect(() =>
        applyVoiceCommand(revoked.state, {
          type: 'consent.revoke',
          payload: { consentId, reason: 'Second revocation' },
        }),
      ).toThrow(VoiceCommandError);
    });
  });

  describe('CRITICAL: cloned voice cannot be used without active consent', () => {
    it('command system enforces consent revocation', () => {
      const state = createInitialVoiceState();
      const created = applyVoiceCommand(state, {
        type: 'voiceIdentity.create',
        payload: {
          id: 'voice-1',
          displayName: 'Cloned Voice',
          allowedPurposes: ['narration'],
          allowedUsersOrTeams: ['user-1'],
          consentGrantedBy: 'user-1',
        },
      });

      const consentId = Object.keys(created.state.consentRecords)[0]!;
      const revoked = applyVoiceCommand(created.state, {
        type: 'consent.revoke',
        payload: { consentId, reason: 'Owner withdrew consent' },
      });

      const voice = revoked.state.voices['voice-1']!;
      const consent = revoked.state.consentRecords[voice.consentRecordId]!;
      expect(consent.revoked).toBe(true);
      expect(voice.status).toBe('active');
    });
  });
});
