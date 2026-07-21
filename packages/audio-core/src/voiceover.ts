import { createHash } from 'node:crypto';

export interface VoiceOverSession {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  status: 'idle' | 'recording' | 'paused' | 'stopped';
  recordedSamples: Float32Array;
  durationUs: number;
}

export function createVoiceOverSession(sampleRate: number, channels: 1 | 2 = 1): VoiceOverSession {
  return {
    sessionId: createHash('sha256')
      .update(`${sampleRate}-${channels}-${Date.now()}`)
      .digest('hex')
      .slice(0, 16),
    startedAt: new Date().toISOString(),
    sampleRate,
    channels,
    status: 'idle',
    recordedSamples: new Float32Array(0),
    durationUs: 0,
  };
}

export function startRecording(session: VoiceOverSession): void {
  if (session.status !== 'idle') {
    throw new Error(`Cannot start recording: session is ${session.status}`);
  }
  session.status = 'recording';
}

export function pauseRecording(session: VoiceOverSession): void {
  if (session.status !== 'recording') {
    throw new Error(`Cannot pause recording: session is ${session.status}`);
  }
  session.status = 'paused';
}

export function resumeRecording(session: VoiceOverSession): void {
  if (session.status !== 'paused') {
    throw new Error(`Cannot resume recording: session is ${session.status}`);
  }
  session.status = 'recording';
}

export function stopRecording(session: VoiceOverSession): Float32Array {
  if (session.status !== 'recording' && session.status !== 'paused') {
    throw new Error(`Cannot stop recording: session is ${session.status}`);
  }
  session.status = 'stopped';
  return session.recordedSamples;
}

export function appendSamples(session: VoiceOverSession, newSamples: Float32Array): void {
  if (session.status !== 'recording') {
    throw new Error(`Cannot append samples: session is ${session.status}`);
  }

  const combined = new Float32Array(session.recordedSamples.length + newSamples.length);
  combined.set(session.recordedSamples, 0);
  combined.set(newSamples, session.recordedSamples.length);
  session.recordedSamples = combined;

  const durationSeconds = newSamples.length / session.sampleRate;
  session.durationUs += Math.floor(durationSeconds * 1_000_000);
}
