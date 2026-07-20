import { describe, expect, it } from 'vitest';
import { createVoiceIsolationAdapter } from './index.js';
import type { VoiceIsolationConfig } from './index.js';
import {
  validateManifest,
  createTestRequest,
  assertResultSucceeded,
  computePrivacyPreflight,
} from '@joy-media/provider-sdk';

const ISOLATE_CONFIG: VoiceIsolationConfig = {
  execution: 'worker-local',
  mode: 'isolate-voice',
  modelPath: '/models/demucs-v3.pth',
};

const REMOVE_CONFIG: VoiceIsolationConfig = {
  execution: 'worker-local',
  mode: 'remove-voice',
};

const SEPARATE_CONFIG: VoiceIsolationConfig = {
  execution: 'remote-api',
  mode: 'separate-stems',
};

describe('createVoiceIsolationAdapter', () => {
  it('creates a provider with valid manifest', () => {
    const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
    const validation = validateManifest(adapter.manifest);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('has correct manifest properties (local)', () => {
    const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
    expect(adapter.manifest.id).toBe('joy.voice-isolation');
    expect(adapter.manifest.protocolVersion).toBe(2);
    expect(adapter.manifest.execution).toBe('worker-local');
    expect(adapter.manifest.privacy.dataLeavesDevice).toBe(false);
  });

  it('has correct manifest properties (remote)', () => {
    const adapter = createVoiceIsolationAdapter(SEPARATE_CONFIG);
    expect(adapter.manifest.execution).toBe('remote-api');
    expect(adapter.manifest.privacy.dataLeavesDevice).toBe(true);
  });

  it('declares audio.separate capability', () => {
    const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
    expect(adapter.manifest.capabilities).toHaveLength(1);
    expect(adapter.manifest.capabilities[0]!.id).toBe('audio.separate');
  });

  it('includes model in capability declaration when modelPath provided', () => {
    const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
    const capability = adapter.manifest.capabilities[0]!;
    expect(capability.models).toBeDefined();
    expect(capability.models![0]!.id).toBe('/models/demucs-v3.pth');
  });
});

describe('VoiceIsolation adapter invoke - isolate-voice', () => {
  it('handles audio.separate successfully', async () => {
    const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
    const audioData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    const result = await adapter.invoke('audio.separate', {
      assetId: 'audio-123',
      data: audioData,
    });

    assertResultSucceeded(result);
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]!.kind).toBe('audio');
    expect(result.outputs[0]!.mimeType).toBe('audio/wav');
    expect(result.outputs[0]!.metadata!.stem).toBe('voice');
  });
});

describe('VoiceIsolation adapter invoke - remove-voice', () => {
  it('handles audio.separate successfully', async () => {
    const adapter = createVoiceIsolationAdapter(REMOVE_CONFIG);
    const audioData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    const result = await adapter.invoke('audio.separate', {
      assetId: 'audio-123',
      data: audioData,
    });

    assertResultSucceeded(result);
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]!.metadata!.stem).toBe('no-voice');
  });
});

describe('VoiceIsolation adapter invoke - separate-stems', () => {
  it('handles audio.separate successfully with multiple stems', async () => {
    const adapter = createVoiceIsolationAdapter(SEPARATE_CONFIG);
    const audioData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    const result = await adapter.invoke('audio.separate', {
      assetId: 'audio-123',
      data: audioData,
    });

    assertResultSucceeded(result);
    expect(result.outputs).toHaveLength(4);
    expect(result.outputs[0]!.metadata!.stem).toBe('vocals');
    expect(result.outputs[1]!.metadata!.stem).toBe('drums');
    expect(result.outputs[2]!.metadata!.stem).toBe('bass');
    expect(result.outputs[3]!.metadata!.stem).toBe('other');
  });
});

describe('VoiceIsolation adapter error handling', () => {
  it('returns failed status for unsupported capability', async () => {
    const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
    const result = await adapter.invoke('audio.denoise', { assetId: 'audio-123' });

    expect(result.status).toBe('failed');
    expect(result.diagnostics[0]!.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('validates missing assetId', async () => {
    const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
    const result = await adapter.invoke('audio.separate', {});

    expect(result.status).toBe('failed');
    expect(result.diagnostics.some((d) => d.code === 'MISSING_ASSET_ID')).toBe(true);
  });

  it('validates invalid data type', async () => {
    const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
    const result = await adapter.invoke('audio.separate', {
      assetId: 'audio-123',
      data: 'not a uint8array',
    });

    expect(result.status).toBe('failed');
    expect(result.diagnostics.some((d) => d.code === 'INVALID_DATA')).toBe(true);
  });

  it('validates null input', async () => {
    const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
    const result = await adapter.invoke('audio.separate', null);

    expect(result.status).toBe('failed');
    expect(result.diagnostics.some((d) => d.code === 'INVALID_INPUT')).toBe(true);
  });
});

describe('VoiceIsolation adapter provenance', () => {
  it('includes full provenance', async () => {
    const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
    const result = await adapter.invoke('audio.separate', {
      assetId: 'audio-123',
      data: new Uint8Array([1, 2, 3]),
    });

    expect(result.provenance.providerId).toBe('joy.voice-isolation');
    expect(result.provenance.modelId).toBe('/models/demucs-v3.pth');
    expect(result.provenance.adapterVersion).toBe('1.0.0');
    expect(result.provenance.execution).toBe('worker-local');
    expect(result.provenance.createdAt).toBeDefined();
    expect(result.provenance.requestHash).toBeDefined();
    expect(result.provenance.idempotencyKey).toBeDefined();
    expect(result.provenance.processingTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('includes metadata in outputs', async () => {
    const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
    const result = await adapter.invoke('audio.separate', {
      assetId: 'audio-123',
      data: new Uint8Array([1, 2, 3]),
    });

    expect(result.outputs[0]!.metadata).toBeDefined();
    expect(result.outputs[0]!.metadata!.sourceAssetId).toBe('audio-123');
    expect(result.outputs[0]!.metadata!.mode).toBe('isolate-voice');
  });

  it('generates unique asset IDs', async () => {
    const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
    const result1 = await adapter.invoke('audio.separate', { assetId: 'audio-1' });
    const result2 = await adapter.invoke('audio.separate', { assetId: 'audio-2' });

    expect(result1.outputs[0]!.assetId).not.toBe(result2.outputs[0]!.assetId);
  });
});

describe('VoiceIsolation adapter privacy', () => {
  it('computes privacy preflight for local execution', () => {
    const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
    const request = createTestRequest('audio.separate', { assetId: 'audio-123' });

    const preflight = computePrivacyPreflight(request, adapter);
    expect(preflight.dataLeavesDevice).toBe(false);
    expect(preflight.requiresUserApproval).toBe(false);
  });

  it('computes privacy preflight for remote execution', () => {
    const adapter = createVoiceIsolationAdapter(SEPARATE_CONFIG);
    const request = createTestRequest('audio.separate', { assetId: 'audio-123' });

    const preflight = computePrivacyPreflight(request, adapter);
    expect(preflight.dataLeavesDevice).toBe(true);
    expect(preflight.requiresUserApproval).toBe(true);
  });
});
