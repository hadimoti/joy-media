import { describe, expect, it } from 'vitest';
import { createSynthesisAuditLog } from './synthesis-audit.js';

describe('SynthesisAuditLog', () => {
  describe('record', () => {
    it('records synthesis entry with generated id and timestamp', () => {
      const log = createSynthesisAuditLog();
      const entry = log.record({
        voiceIdentityId: 'voice-1',
        voiceDisplayName: 'Test Voice',
        capability: 'speech.synthesize',
        userId: 'user-1',
        purpose: 'narration',
        inputText: 'Hello world',
        outputAssetId: 'asset-1',
        providerId: 'joy.tts-kokoro',
        modelId: 'kokoro',
        consentRecordId: 'consent-1',
      });

      expect(entry.id).toBeDefined();
      expect(entry.timestamp).toBeDefined();
      expect(entry.voiceIdentityId).toBe('voice-1');
      expect(entry.voiceDisplayName).toBe('Test Voice');
      expect(entry.capability).toBe('speech.synthesize');
      expect(entry.userId).toBe('user-1');
      expect(entry.purpose).toBe('narration');
      expect(entry.inputText).toBe('Hello world');
      expect(entry.outputAssetId).toBe('asset-1');
      expect(entry.providerId).toBe('joy.tts-kokoro');
      expect(entry.modelId).toBe('kokoro');
      expect(entry.consentRecordId).toBe('consent-1');
    });

    it('records multiple entries', () => {
      const log = createSynthesisAuditLog();
      log.record({
        voiceIdentityId: 'voice-1',
        voiceDisplayName: 'Voice 1',
        capability: 'speech.synthesize',
        userId: 'user-1',
        purpose: 'narration',
        inputText: 'First',
        outputAssetId: 'asset-1',
        providerId: 'joy.tts-kokoro',
        modelId: 'kokoro',
        consentRecordId: 'consent-1',
      });
      log.record({
        voiceIdentityId: 'voice-2',
        voiceDisplayName: 'Voice 2',
        capability: 'speech.synthesize',
        userId: 'user-1',
        purpose: 'demo',
        inputText: 'Second',
        outputAssetId: 'asset-2',
        providerId: 'joy.tts-kokoro',
        modelId: 'kokoro',
        consentRecordId: 'consent-2',
      });

      expect(log.getAllEntries()).toHaveLength(2);
    });
  });

  describe('getEntriesForVoice', () => {
    it('returns entries for specific voice', () => {
      const log = createSynthesisAuditLog();
      log.record({
        voiceIdentityId: 'voice-1',
        voiceDisplayName: 'Voice 1',
        capability: 'speech.synthesize',
        userId: 'user-1',
        purpose: 'narration',
        inputText: 'First',
        outputAssetId: 'asset-1',
        providerId: 'joy.tts-kokoro',
        modelId: 'kokoro',
        consentRecordId: 'consent-1',
      });
      log.record({
        voiceIdentityId: 'voice-2',
        voiceDisplayName: 'Voice 2',
        capability: 'speech.synthesize',
        userId: 'user-1',
        purpose: 'demo',
        inputText: 'Second',
        outputAssetId: 'asset-2',
        providerId: 'joy.tts-kokoro',
        modelId: 'kokoro',
        consentRecordId: 'consent-2',
      });
      log.record({
        voiceIdentityId: 'voice-1',
        voiceDisplayName: 'Voice 1',
        capability: 'speech.synthesize',
        userId: 'user-1',
        purpose: 'narration',
        inputText: 'Third',
        outputAssetId: 'asset-3',
        providerId: 'joy.tts-kokoro',
        modelId: 'kokoro',
        consentRecordId: 'consent-1',
      });

      const entries = log.getEntriesForVoice('voice-1');
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.voiceIdentityId === 'voice-1')).toBe(true);
    });

    it('returns empty array when no entries match', () => {
      const log = createSynthesisAuditLog();
      const entries = log.getEntriesForVoice('non-existent');
      expect(entries).toHaveLength(0);
    });
  });

  describe('getEntriesForUser', () => {
    it('returns entries for specific user', () => {
      const log = createSynthesisAuditLog();
      log.record({
        voiceIdentityId: 'voice-1',
        voiceDisplayName: 'Voice 1',
        capability: 'speech.synthesize',
        userId: 'user-1',
        purpose: 'narration',
        inputText: 'First',
        outputAssetId: 'asset-1',
        providerId: 'joy.tts-kokoro',
        modelId: 'kokoro',
        consentRecordId: 'consent-1',
      });
      log.record({
        voiceIdentityId: 'voice-2',
        voiceDisplayName: 'Voice 2',
        capability: 'speech.synthesize',
        userId: 'user-2',
        purpose: 'demo',
        inputText: 'Second',
        outputAssetId: 'asset-2',
        providerId: 'joy.tts-kokoro',
        modelId: 'kokoro',
        consentRecordId: 'consent-2',
      });

      const entries = log.getEntriesForUser('user-1');
      expect(entries).toHaveLength(1);
      expect(entries[0]!.userId).toBe('user-1');
    });
  });

  describe('getEntriesInRange', () => {
    it('returns entries within time range', () => {
      const log = createSynthesisAuditLog();
      log.record({
        voiceIdentityId: 'voice-1',
        voiceDisplayName: 'Voice 1',
        capability: 'speech.synthesize',
        userId: 'user-1',
        purpose: 'narration',
        inputText: 'First',
        outputAssetId: 'asset-1',
        providerId: 'joy.tts-kokoro',
        modelId: 'kokoro',
        consentRecordId: 'consent-1',
      });

      const entries = log.getEntriesInRange('2020-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      expect(entries.length).toBeGreaterThan(0);
    });

    it('returns empty array when no entries in range', () => {
      const log = createSynthesisAuditLog();
      log.record({
        voiceIdentityId: 'voice-1',
        voiceDisplayName: 'Voice 1',
        capability: 'speech.synthesize',
        userId: 'user-1',
        purpose: 'narration',
        inputText: 'First',
        outputAssetId: 'asset-1',
        providerId: 'joy.tts-kokoro',
        modelId: 'kokoro',
        consentRecordId: 'consent-1',
      });

      const entries = log.getEntriesInRange('2020-01-01T00:00:00.000Z', '2020-12-31T23:59:59.000Z');
      expect(entries).toHaveLength(0);
    });
  });

  describe('getAllEntries', () => {
    it('returns all entries', () => {
      const log = createSynthesisAuditLog();
      log.record({
        voiceIdentityId: 'voice-1',
        voiceDisplayName: 'Voice 1',
        capability: 'speech.synthesize',
        userId: 'user-1',
        purpose: 'narration',
        inputText: 'First',
        outputAssetId: 'asset-1',
        providerId: 'joy.tts-kokoro',
        modelId: 'kokoro',
        consentRecordId: 'consent-1',
      });
      log.record({
        voiceIdentityId: 'voice-2',
        voiceDisplayName: 'Voice 2',
        capability: 'speech.synthesize',
        userId: 'user-2',
        purpose: 'demo',
        inputText: 'Second',
        outputAssetId: 'asset-2',
        providerId: 'joy.tts-kokoro',
        modelId: 'kokoro',
        consentRecordId: 'consent-2',
      });

      const entries = log.getAllEntries();
      expect(entries).toHaveLength(2);
    });

    it('returns a copy, not the internal array', () => {
      const log = createSynthesisAuditLog();
      log.record({
        voiceIdentityId: 'voice-1',
        voiceDisplayName: 'Voice 1',
        capability: 'speech.synthesize',
        userId: 'user-1',
        purpose: 'narration',
        inputText: 'First',
        outputAssetId: 'asset-1',
        providerId: 'joy.tts-kokoro',
        modelId: 'kokoro',
        consentRecordId: 'consent-1',
      });

      const entries1 = log.getAllEntries();
      const entries2 = log.getAllEntries();
      expect(entries1).not.toBe(entries2);
      expect(entries1).toEqual(entries2);
    });
  });
});
