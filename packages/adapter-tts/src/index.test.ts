import { describe, expect, it } from 'vitest';
import { createFixtureTTSAdapter, createTTSAdapter } from './index.js';
import type { TTSConfig } from './index.js';
import {
  validateManifest,
  createTestRequest,
  assertResultSucceeded,
  computePrivacyPreflight,
} from '@joy-media/provider-sdk';

const LOCAL_CONFIG: TTSConfig = {
  execution: 'worker-local',
  engine: 'kokoro',
  modelId: 'kokoro-v1',
};

const REMOTE_CONFIG: TTSConfig = {
  execution: 'remote-api',
  engine: 'elevenlabs',
  apiKey: 'test-api-key',
};

const FISH_SPEECH_CONFIG: TTSConfig = {
  execution: 'worker-local',
  engine: 'fish-speech',
};

describe('createTTSAdapter', () => {
  it('creates a provider with valid manifest (local)', () => {
    const adapter = createTTSAdapter(LOCAL_CONFIG);
    const validation = validateManifest(adapter.manifest);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('creates a provider with valid manifest (remote)', () => {
    const adapter = createTTSAdapter(REMOTE_CONFIG);
    const validation = validateManifest(adapter.manifest);
    expect(validation.valid).toBe(true);
  });

  it('has correct manifest properties (local)', () => {
    const adapter = createTTSAdapter(LOCAL_CONFIG);
    expect(adapter.manifest.id).toBe('joy.tts-kokoro');
    expect(adapter.manifest.protocolVersion).toBe(2);
    expect(adapter.manifest.execution).toBe('worker-local');
    expect(adapter.manifest.privacy.dataLeavesDevice).toBe(false);
  });

  it('has correct manifest properties (remote)', () => {
    const adapter = createTTSAdapter(REMOTE_CONFIG);
    expect(adapter.manifest.id).toBe('joy.tts-elevenlabs');
    expect(adapter.manifest.execution).toBe('remote-api');
    expect(adapter.manifest.privacy.dataLeavesDevice).toBe(true);
  });

  it('declares speech.synthesize capability', () => {
    const adapter = createTTSAdapter(LOCAL_CONFIG);
    expect(adapter.manifest.capabilities).toHaveLength(1);
    expect(adapter.manifest.capabilities[0]!.id).toBe('speech.synthesize');
  });

  it('includes model in capability declaration', () => {
    const adapter = createTTSAdapter(LOCAL_CONFIG);
    const capability = adapter.manifest.capabilities[0]!;
    expect(capability.models).toBeDefined();
    expect(capability.models![0]!.id).toBe('kokoro-v1');
  });

  it('includes apiKey in secretFields when provided', () => {
    const adapter = createTTSAdapter(REMOTE_CONFIG);
    expect(adapter.manifest.secretFields).toContain('apiKey');
  });

  it('has empty secretFields when no apiKey', () => {
    const adapter = createTTSAdapter(LOCAL_CONFIG);
    expect(adapter.manifest.secretFields).toEqual([]);
  });

  it('throws on invalid engine', () => {
    expect(() =>
      createTTSAdapter({ execution: 'worker-local', engine: 'invalid-engine' as never }),
    ).toThrow(RangeError);
  });

  it('throws when remote engine used with local execution', () => {
    expect(() => createTTSAdapter({ execution: 'worker-local', engine: 'elevenlabs' })).toThrow(
      /requires remote-api execution/,
    );
    expect(() => createTTSAdapter({ execution: 'worker-local', engine: 'edge-tts' })).toThrow(
      /requires remote-api execution/,
    );
  });

  it('declares edge-tts as remote with data-leaves-device disclosure', () => {
    const adapter = createTTSAdapter({ execution: 'remote-api', engine: 'edge-tts' });
    expect(adapter.manifest.execution).toBe('remote-api');
    expect(adapter.manifest.privacy.dataLeavesDevice).toBe(true);
    expect(adapter.manifest.privacy.retentionDisclosure).toMatch(/Microsoft Edge/i);
  });

  it('uses engine name as modelId when modelId not provided', () => {
    const adapter = createTTSAdapter(FISH_SPEECH_CONFIG);
    const capability = adapter.manifest.capabilities[0]!;
    expect(capability.models![0]!.id).toBe('fish-speech');
  });
});

describe('TTS adapter invoke', () => {
  it('handles speech.synthesize successfully', async () => {
    const adapter = createFixtureTTSAdapter(LOCAL_CONFIG);
    const result = await adapter.invoke('speech.synthesize', {
      text: 'Hello world',
    });

    assertResultSucceeded(result);
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]!.kind).toBe('audio');
    expect(result.outputs[0]!.mimeType).toBe('audio/wav');
    expect(result.outputs[0]!.bytes).toBeInstanceOf(Uint8Array);
  });

  it('returns failed status for unsupported capability', async () => {
    const adapter = createTTSAdapter(LOCAL_CONFIG);
    const result = await adapter.invoke('speech.transcribe', { assetId: 'audio-123' });

    expect(result.status).toBe('failed');
    expect(result.diagnostics[0]!.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('validates missing text', async () => {
    const adapter = createTTSAdapter(LOCAL_CONFIG);
    const result = await adapter.invoke('speech.synthesize', {});

    expect(result.status).toBe('failed');
    expect(result.diagnostics.some((d) => d.code === 'MISSING_TEXT')).toBe(true);
  });

  it('validates empty text', async () => {
    const adapter = createTTSAdapter(LOCAL_CONFIG);
    const result = await adapter.invoke('speech.synthesize', { text: '' });

    expect(result.status).toBe('failed');
    expect(result.diagnostics.some((d) => d.code === 'MISSING_TEXT')).toBe(true);
  });

  it('validates invalid speed', async () => {
    const adapter = createTTSAdapter(LOCAL_CONFIG);
    const result = await adapter.invoke('speech.synthesize', {
      text: 'Hello',
      speed: 3.0,
    });

    expect(result.status).toBe('failed');
    expect(result.diagnostics.some((d) => d.code === 'INVALID_SPEED')).toBe(true);
  });

  it('validates invalid pitch', async () => {
    const adapter = createTTSAdapter(LOCAL_CONFIG);
    const result = await adapter.invoke('speech.synthesize', {
      text: 'Hello',
      pitch: 20,
    });

    expect(result.status).toBe('failed');
    expect(result.diagnostics.some((d) => d.code === 'INVALID_PITCH')).toBe(true);
  });

  it('includes word timing metadata', async () => {
    const adapter = createFixtureTTSAdapter(LOCAL_CONFIG);
    const result = await adapter.invoke('speech.synthesize', {
      text: 'Hello world test',
    });

    assertResultSucceeded(result);
    const metadata = result.outputs[0]!.metadata!;
    expect(metadata.wordTimings).toBeDefined();
    expect(Array.isArray(metadata.wordTimings)).toBe(true);
    const timings = metadata.wordTimings as Array<{ word: string; startUs: number; endUs: number }>;
    expect(timings).toHaveLength(3);
    expect(timings[0]!.word).toBe('Hello');
    expect(timings[1]!.word).toBe('world');
    expect(timings[2]!.word).toBe('test');
    expect(timings[0]!.startUs).toBe(0);
    expect(timings[0]!.endUs).toBeGreaterThan(0);
  });

  it('includes full provenance', async () => {
    const adapter = createFixtureTTSAdapter(LOCAL_CONFIG);
    const result = await adapter.invoke('speech.synthesize', {
      text: 'Hello',
    });

    expect(result.provenance.providerId).toBe('joy.tts-kokoro');
    expect(result.provenance.modelId).toBe('kokoro-v1');
    expect(result.provenance.adapterVersion).toBe('1.0.0');
    expect(result.provenance.execution).toBe('worker-local');
    expect(result.provenance.createdAt).toBeDefined();
    expect(result.provenance.requestHash).toBeDefined();
    expect(result.provenance.idempotencyKey).toBeDefined();
    expect(result.provenance.processingTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('includes metadata in output', async () => {
    const adapter = createFixtureTTSAdapter(LOCAL_CONFIG);
    const result = await adapter.invoke('speech.synthesize', {
      text: 'Hello',
      language: 'ja',
      speed: 1.5,
      pitch: 2,
    });

    const metadata = result.outputs[0]!.metadata!;
    expect(metadata.engine).toBe('kokoro');
    expect(metadata.language).toBe('ja');
    expect(metadata.speed).toBe(1.5);
    expect(metadata.pitch).toBe(2);
    expect(metadata.sampleRate).toBe(24000);
  });

  it('uses voiceId from config when not in input', async () => {
    const adapter = createFixtureTTSAdapter({
      ...LOCAL_CONFIG,
      voiceId: 'config-voice',
    });
    const result = await adapter.invoke('speech.synthesize', {
      text: 'Hello',
    });

    expect(result.outputs[0]!.metadata!.voiceId).toBe('config-voice');
  });

  it('input voiceId overrides config voiceId', async () => {
    const adapter = createFixtureTTSAdapter({
      ...LOCAL_CONFIG,
      voiceId: 'config-voice',
    });
    const result = await adapter.invoke('speech.synthesize', {
      text: 'Hello',
      voiceId: 'input-voice',
    });

    expect(result.outputs[0]!.metadata!.voiceId).toBe('input-voice');
  });

  it('generates unique asset IDs', async () => {
    const adapter = createFixtureTTSAdapter(LOCAL_CONFIG);
    const result1 = await adapter.invoke('speech.synthesize', { text: 'Hello' });
    const result2 = await adapter.invoke('speech.synthesize', { text: 'World' });

    expect(result1.outputs[0]!.assetId).not.toBe(result2.outputs[0]!.assetId);
  });

  it('supports all valid engines', async () => {
    const engines: Array<'fish-speech' | 'f5-tts' | 'kokoro' | 'chatterbox'> = [
      'fish-speech',
      'f5-tts',
      'kokoro',
      'chatterbox',
    ];

    for (const engine of engines) {
      const adapter = createFixtureTTSAdapter({ execution: 'worker-local', engine });
      const result = await adapter.invoke('speech.synthesize', { text: 'Test' });
      assertResultSucceeded(result);
      expect(result.outputs[0]!.metadata!.engine).toBe(engine);
    }
  });
});

describe('TTS adapter privacy', () => {
  it('computes privacy preflight for local execution', () => {
    const adapter = createTTSAdapter(LOCAL_CONFIG);
    const request = createTestRequest('speech.synthesize', { text: 'Hello' });

    const preflight = computePrivacyPreflight(request, adapter);
    expect(preflight.dataLeavesDevice).toBe(false);
    expect(preflight.requiresUserApproval).toBe(false);
  });

  it('computes privacy preflight for remote execution', () => {
    const adapter = createTTSAdapter(REMOTE_CONFIG);
    const request = createTestRequest('speech.synthesize', { text: 'Hello' });

    const preflight = computePrivacyPreflight(request, adapter);
    expect(preflight.dataLeavesDevice).toBe(true);
    expect(preflight.requiresUserApproval).toBe(true);
  });
});

describe('TTS adapter voice cloning support', () => {
  it('accepts voiceId for future voice cloning integration', async () => {
    const adapter = createFixtureTTSAdapter(LOCAL_CONFIG);
    const result = await adapter.invoke('speech.synthesize', {
      text: 'Hello with cloned voice',
      voiceId: 'voice-identity-123',
    });

    assertResultSucceeded(result);
    expect(result.outputs[0]!.metadata!.voiceId).toBe('voice-identity-123');
  });
});
