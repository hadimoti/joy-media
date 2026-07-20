import { describe, expect, it } from 'vitest';
import { createNoiseRemovalAdapter } from './index.js';
import type { NoiseRemovalConfig } from './index.js';
import {
  validateManifest,
  createTestRequest,
  assertResultSucceeded,
  computePrivacyPreflight,
} from '@joy-media/provider-sdk';

const LOCAL_CONFIG: NoiseRemovalConfig = {
  execution: 'worker-local',
  strength: 0.8,
  modelPath: '/models/demucs-v3.pth',
};

const REMOTE_CONFIG: NoiseRemovalConfig = {
  execution: 'remote-api',
  strength: 0.5,
};

describe('createNoiseRemovalAdapter', () => {
  it('creates a provider with valid manifest (local)', () => {
    const adapter = createNoiseRemovalAdapter(LOCAL_CONFIG);
    const validation = validateManifest(adapter.manifest);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('creates a provider with valid manifest (remote)', () => {
    const adapter = createNoiseRemovalAdapter(REMOTE_CONFIG);
    const validation = validateManifest(adapter.manifest);
    expect(validation.valid).toBe(true);
  });

  it('has correct manifest properties (local)', () => {
    const adapter = createNoiseRemovalAdapter(LOCAL_CONFIG);
    expect(adapter.manifest.id).toBe('joy.noise-removal');
    expect(adapter.manifest.protocolVersion).toBe(2);
    expect(adapter.manifest.execution).toBe('worker-local');
    expect(adapter.manifest.privacy.dataLeavesDevice).toBe(false);
  });

  it('has correct manifest properties (remote)', () => {
    const adapter = createNoiseRemovalAdapter(REMOTE_CONFIG);
    expect(adapter.manifest.execution).toBe('remote-api');
    expect(adapter.manifest.privacy.dataLeavesDevice).toBe(true);
  });

  it('declares audio.denoise capability', () => {
    const adapter = createNoiseRemovalAdapter(LOCAL_CONFIG);
    expect(adapter.manifest.capabilities).toHaveLength(1);
    expect(adapter.manifest.capabilities[0]!.id).toBe('audio.denoise');
  });

  it('includes model in capability declaration when modelPath provided', () => {
    const adapter = createNoiseRemovalAdapter(LOCAL_CONFIG);
    const capability = adapter.manifest.capabilities[0]!;
    expect(capability.models).toBeDefined();
    expect(capability.models![0]!.id).toBe('/models/demucs-v3.pth');
  });

  it('throws on invalid strength', () => {
    expect(() =>
      createNoiseRemovalAdapter({ execution: 'worker-local', strength: 1.5 }),
    ).toThrow(RangeError);
    expect(() =>
      createNoiseRemovalAdapter({ execution: 'worker-local', strength: -0.1 }),
    ).toThrow(RangeError);
  });

  it('throws on invalid preserveFrequencies', () => {
    expect(() =>
      createNoiseRemovalAdapter({
        execution: 'worker-local',
        strength: 0.5,
        preserveFrequencies: { min: 1000, max: 500 },
      }),
    ).toThrow(RangeError);
  });
});

describe('NoiseRemoval adapter invoke', () => {
  it('handles audio.denoise successfully', async () => {
    const adapter = createNoiseRemovalAdapter(LOCAL_CONFIG);
    const audioData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    const result = await adapter.invoke('audio.denoise', {
      assetId: 'audio-123',
      data: audioData,
    });

    assertResultSucceeded(result);
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]!.kind).toBe('audio');
    expect(result.outputs[0]!.mimeType).toBe('audio/wav');
    expect(result.outputs[0]!.bytes).toBeInstanceOf(Uint8Array);
  });

  it('returns failed status for unsupported capability', async () => {
    const adapter = createNoiseRemovalAdapter(LOCAL_CONFIG);
    const result = await adapter.invoke('audio.separate', { assetId: 'audio-123' });

    expect(result.status).toBe('failed');
    expect(result.diagnostics[0]!.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('validates missing assetId', async () => {
    const adapter = createNoiseRemovalAdapter(LOCAL_CONFIG);
    const result = await adapter.invoke('audio.denoise', {});

    expect(result.status).toBe('failed');
    expect(result.diagnostics.some((d) => d.code === 'MISSING_ASSET_ID')).toBe(true);
  });

  it('validates invalid data type', async () => {
    const adapter = createNoiseRemovalAdapter(LOCAL_CONFIG);
    const result = await adapter.invoke('audio.denoise', {
      assetId: 'audio-123',
      data: 'not a uint8array',
    });

    expect(result.status).toBe('failed');
    expect(result.diagnostics.some((d) => d.code === 'INVALID_DATA')).toBe(true);
  });

  it('includes full provenance', async () => {
    const adapter = createNoiseRemovalAdapter(LOCAL_CONFIG);
    const result = await adapter.invoke('audio.denoise', {
      assetId: 'audio-123',
      data: new Uint8Array([1, 2, 3]),
    });

    expect(result.provenance.providerId).toBe('joy.noise-removal');
    expect(result.provenance.modelId).toBe('/models/demucs-v3.pth');
    expect(result.provenance.adapterVersion).toBe('1.0.0');
    expect(result.provenance.execution).toBe('worker-local');
    expect(result.provenance.createdAt).toBeDefined();
    expect(result.provenance.requestHash).toBeDefined();
    expect(result.provenance.idempotencyKey).toBeDefined();
    expect(result.provenance.processingTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('includes metadata in output', async () => {
    const adapter = createNoiseRemovalAdapter(LOCAL_CONFIG);
    const result = await adapter.invoke('audio.denoise', {
      assetId: 'audio-123',
      data: new Uint8Array([1, 2, 3]),
      sampleRate: 44100,
    });

    expect(result.outputs[0]!.metadata).toBeDefined();
    expect(result.outputs[0]!.metadata!.sourceAssetId).toBe('audio-123');
    expect(result.outputs[0]!.metadata!.strength).toBe(0.8);
    expect(result.outputs[0]!.metadata!.execution).toBe('worker-local');
    expect(result.outputs[0]!.metadata!.sampleRate).toBe(44100);
  });

  it('uses default sampleRate when not provided', async () => {
    const adapter = createNoiseRemovalAdapter(LOCAL_CONFIG);
    const result = await adapter.invoke('audio.denoise', {
      assetId: 'audio-123',
    });

    assertResultSucceeded(result);
    expect(result.outputs[0]!.metadata!.sampleRate).toBe(48000);
  });

  it('generates unique asset IDs', async () => {
    const adapter = createNoiseRemovalAdapter(LOCAL_CONFIG);
    const result1 = await adapter.invoke('audio.denoise', { assetId: 'audio-1' });
    const result2 = await adapter.invoke('audio.denoise', { assetId: 'audio-2' });

    expect(result1.outputs[0]!.assetId).not.toBe(result2.outputs[0]!.assetId);
  });
});

describe('NoiseRemoval adapter privacy', () => {
  it('computes privacy preflight for local execution', () => {
    const adapter = createNoiseRemovalAdapter(LOCAL_CONFIG);
    const request = createTestRequest('audio.denoise', { assetId: 'audio-123' });

    const preflight = computePrivacyPreflight(request, adapter);
    expect(preflight.dataLeavesDevice).toBe(false);
    expect(preflight.requiresUserApproval).toBe(false);
  });

  it('computes privacy preflight for remote execution', () => {
    const adapter = createNoiseRemovalAdapter(REMOTE_CONFIG);
    const request = createTestRequest('audio.denoise', { assetId: 'audio-123' });

    const preflight = computePrivacyPreflight(request, adapter);
    expect(preflight.dataLeavesDevice).toBe(true);
    expect(preflight.requiresUserApproval).toBe(true);
  });
});

describe('NoiseRemoval adapter with preserveFrequencies', () => {
  it('accepts valid preserveFrequencies config', () => {
    const adapter = createNoiseRemovalAdapter({
      execution: 'worker-local',
      strength: 0.5,
      preserveFrequencies: { min: 200, max: 4000 },
    });

    expect(adapter.manifest.capabilities).toHaveLength(1);
  });
});
