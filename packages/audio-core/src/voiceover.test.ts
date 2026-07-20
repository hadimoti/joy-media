import { describe, expect, it } from 'vitest';
import {
  createVoiceOverSession,
  startRecording,
  pauseRecording,
  resumeRecording,
  stopRecording,
  appendSamples,
} from './voiceover.js';

describe('voice-over recording', () => {
  describe('createVoiceOverSession', () => {
    it('creates session with correct initial state', () => {
      const session = createVoiceOverSession(48000, 1);
      expect(session.sampleRate).toBe(48000);
      expect(session.channels).toBe(1);
      expect(session.status).toBe('idle');
      expect(session.recordedSamples.length).toBe(0);
      expect(session.durationUs).toBe(0);
      expect(session.sessionId).toBeDefined();
      expect(session.startedAt).toBeDefined();
    });

    it('defaults to mono (1 channel)', () => {
      const session = createVoiceOverSession(44100);
      expect(session.channels).toBe(1);
    });

    it('supports stereo (2 channels)', () => {
      const session = createVoiceOverSession(48000, 2);
      expect(session.channels).toBe(2);
    });
  });

  describe('startRecording', () => {
    it('transitions from idle to recording', () => {
      const session = createVoiceOverSession(48000);
      expect(session.status).toBe('idle');
      startRecording(session);
      expect(session.status).toBe('recording');
    });

    it('throws if not idle', () => {
      const session = createVoiceOverSession(48000);
      startRecording(session);
      expect(() => startRecording(session)).toThrow('Cannot start recording');
    });
  });

  describe('pauseRecording', () => {
    it('transitions from recording to paused', () => {
      const session = createVoiceOverSession(48000);
      startRecording(session);
      pauseRecording(session);
      expect(session.status).toBe('paused');
    });

    it('throws if not recording', () => {
      const session = createVoiceOverSession(48000);
      expect(() => pauseRecording(session)).toThrow('Cannot pause recording');
    });
  });

  describe('resumeRecording', () => {
    it('transitions from paused to recording', () => {
      const session = createVoiceOverSession(48000);
      startRecording(session);
      pauseRecording(session);
      resumeRecording(session);
      expect(session.status).toBe('recording');
    });

    it('throws if not paused', () => {
      const session = createVoiceOverSession(48000);
      startRecording(session);
      expect(() => resumeRecording(session)).toThrow('Cannot resume recording');
    });
  });

  describe('stopRecording', () => {
    it('transitions to stopped and returns samples', () => {
      const session = createVoiceOverSession(48000);
      startRecording(session);
      const samples = new Float32Array([0.1, 0.2, 0.3]);
      appendSamples(session, samples);
      const result = stopRecording(session);
      expect(session.status).toBe('stopped');
      expect(result).toBe(session.recordedSamples);
      expect(result.length).toBe(3);
    });

    it('can stop from paused state', () => {
      const session = createVoiceOverSession(48000);
      startRecording(session);
      pauseRecording(session);
      const result = stopRecording(session);
      expect(session.status).toBe('stopped');
      expect(result.length).toBe(0);
    });

    it('throws if not recording or paused', () => {
      const session = createVoiceOverSession(48000);
      expect(() => stopRecording(session)).toThrow('Cannot stop recording');
    });
  });

  describe('appendSamples', () => {
    it('accumulates samples correctly', () => {
      const session = createVoiceOverSession(48000);
      startRecording(session);

      const samples1 = new Float32Array([0.1, 0.2, 0.3]);
      appendSamples(session, samples1);
      expect(session.recordedSamples.length).toBe(3);
      expect(session.recordedSamples[0]).toBeCloseTo(0.1);
      expect(session.recordedSamples[1]).toBeCloseTo(0.2);
      expect(session.recordedSamples[2]).toBeCloseTo(0.3);

      const samples2 = new Float32Array([0.4, 0.5]);
      appendSamples(session, samples2);
      expect(session.recordedSamples.length).toBe(5);
      expect(session.recordedSamples[3]).toBeCloseTo(0.4);
      expect(session.recordedSamples[4]).toBeCloseTo(0.5);
    });

    it('calculates duration correctly', () => {
      const session = createVoiceOverSession(48000);
      startRecording(session);

      const samples1 = new Float32Array(48000);
      appendSamples(session, samples1);
      expect(session.durationUs).toBe(1_000_000);

      const samples2 = new Float32Array(24000);
      appendSamples(session, samples2);
      expect(session.durationUs).toBe(1_500_000);
    });

    it('throws if not recording', () => {
      const session = createVoiceOverSession(48000);
      const samples = new Float32Array([0.1]);
      expect(() => appendSamples(session, samples)).toThrow('Cannot append samples');
    });

    it('throws if paused', () => {
      const session = createVoiceOverSession(48000);
      startRecording(session);
      pauseRecording(session);
      const samples = new Float32Array([0.1]);
      expect(() => appendSamples(session, samples)).toThrow('Cannot append samples');
    });
  });

  describe('full lifecycle', () => {
    it('supports complete recording workflow', () => {
      const session = createVoiceOverSession(48000);
      expect(session.status).toBe('idle');

      startRecording(session);
      expect(session.status).toBe('recording');

      appendSamples(session, new Float32Array([0.1, 0.2]));
      expect(session.recordedSamples.length).toBe(2);

      pauseRecording(session);
      expect(session.status).toBe('paused');

      resumeRecording(session);
      expect(session.status).toBe('recording');

      appendSamples(session, new Float32Array([0.3, 0.4]));
      expect(session.recordedSamples.length).toBe(4);

      const result = stopRecording(session);
      expect(session.status).toBe('stopped');
      expect(result.length).toBe(4);
      expect(result[0]).toBeCloseTo(0.1);
      expect(result[3]).toBeCloseTo(0.4);
    });
  });
});
