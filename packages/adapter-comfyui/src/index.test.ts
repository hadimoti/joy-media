import { describe, expect, it } from 'vitest';
import {
  createComfyUIAdapter,
  IMAGE_UPSCALE_TEMPLATE,
  BACKGROUND_REMOVAL_TEMPLATE,
} from './index.js';
import type { ComfyUIAdapterConfig, ComfyUIWorkflowTemplate } from './index.js';
import {
  validateManifest,
  createTestRequest,
  assertResultSucceeded,
  computePrivacyPreflight,
} from '@joy-media/provider-sdk';

const DEFAULT_CONFIG: ComfyUIAdapterConfig = {
  endpoint: 'http://localhost:8188',
  timeoutMs: 30000,
  pollIntervalMs: 500,
};

describe('createComfyUIAdapter', () => {
  it('creates a provider with valid manifest', () => {
    const adapter = createComfyUIAdapter(DEFAULT_CONFIG, [IMAGE_UPSCALE_TEMPLATE]);
    const validation = validateManifest(adapter.manifest);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('has correct manifest properties', () => {
    const adapter = createComfyUIAdapter(DEFAULT_CONFIG, [IMAGE_UPSCALE_TEMPLATE]);
    expect(adapter.manifest.id).toBe('joy.comfyui');
    expect(adapter.manifest.protocolVersion).toBe(2);
    expect(adapter.manifest.execution).toBe('remote-api');
    expect(adapter.manifest.privacy.dataLeavesDevice).toBe(true);
  });

  it('declares capabilities from templates', () => {
    const adapter = createComfyUIAdapter(DEFAULT_CONFIG, [
      IMAGE_UPSCALE_TEMPLATE,
      BACKGROUND_REMOVAL_TEMPLATE,
    ]);
    expect(adapter.manifest.capabilities).toHaveLength(2);
    expect(adapter.manifest.capabilities[0]!.id).toBe('image.upscale');
    expect(adapter.manifest.capabilities[1]!.id).toBe('image.removeBackground');
  });

  it('deduplicates capabilities from multiple templates', () => {
    const duplicateTemplate: ComfyUIWorkflowTemplate = {
      ...IMAGE_UPSCALE_TEMPLATE,
      templateId: 'image-upscale-v2',
      version: '2.0.0',
    };
    const adapter = createComfyUIAdapter(DEFAULT_CONFIG, [
      IMAGE_UPSCALE_TEMPLATE,
      duplicateTemplate,
    ]);
    expect(adapter.manifest.capabilities).toHaveLength(1);
  });
});

describe('ComfyUI adapter invoke', () => {
  it('handles image.upscale successfully', async () => {
    const adapter = createComfyUIAdapter(DEFAULT_CONFIG, [IMAGE_UPSCALE_TEMPLATE]);
    const request = createTestRequest('image.upscale', {
      image: new Uint8Array([1, 2, 3]),
      scale: 2,
    });

    const result = await adapter.invoke('image.upscale', request.input);
    assertResultSucceeded(result);
    expect(result.outputs.length).toBeGreaterThan(0);
    expect(result.outputs[0]!.kind).toBe('image');
    expect(result.outputs[0]!.mimeType).toBe('image/png');
  });

  it('handles image.removeBackground successfully', async () => {
    const adapter = createComfyUIAdapter(DEFAULT_CONFIG, [BACKGROUND_REMOVAL_TEMPLATE]);
    const result = await adapter.invoke('image.removeBackground', {
      image: new Uint8Array([1, 2, 3]),
    });

    assertResultSucceeded(result);
    expect(result.outputs).toHaveLength(2);
    expect(result.outputs[0]!.kind).toBe('image');
    expect(result.outputs[1]!.kind).toBe('image');
  });

  it('returns failed status for unsupported capability', async () => {
    const adapter = createComfyUIAdapter(DEFAULT_CONFIG, [IMAGE_UPSCALE_TEMPLATE]);
    const result = await adapter.invoke('image.generate', {});

    expect(result.status).toBe('failed');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('validates required inputs', async () => {
    const adapter = createComfyUIAdapter(DEFAULT_CONFIG, [IMAGE_UPSCALE_TEMPLATE]);
    const result = await adapter.invoke('image.upscale', {});

    expect(result.status).toBe('failed');
    expect(result.diagnostics.some((d) => d.code === 'MISSING_REQUIRED_INPUT')).toBe(true);
  });

  it('includes full provenance', async () => {
    const adapter = createComfyUIAdapter(DEFAULT_CONFIG, [IMAGE_UPSCALE_TEMPLATE]);
    const result = await adapter.invoke('image.upscale', {
      image: new Uint8Array([1, 2, 3]),
    });

    expect(result.provenance.providerId).toBe('joy.comfyui');
    expect(result.provenance.modelId).toBe('image-upscale-v1');
    expect(result.provenance.adapterVersion).toBe('1.0.0');
    expect(result.provenance.execution).toBe('remote-api');
    expect(result.provenance.createdAt).toBeDefined();
    expect(result.provenance.requestHash).toBeDefined();
    expect(result.provenance.idempotencyKey).toBeDefined();
    expect(result.provenance.processingTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('includes output metadata', async () => {
    const adapter = createComfyUIAdapter(DEFAULT_CONFIG, [IMAGE_UPSCALE_TEMPLATE]);
    const result = await adapter.invoke('image.upscale', {
      image: new Uint8Array([1, 2, 3]),
    });

    expect(result.outputs[0]!.metadata).toBeDefined();
    expect(result.outputs[0]!.metadata!.templateId).toBe('image-upscale-v1');
  });

  it('uses default values for optional inputs', async () => {
    const adapter = createComfyUIAdapter(DEFAULT_CONFIG, [IMAGE_UPSCALE_TEMPLATE]);
    const result = await adapter.invoke('image.upscale', {
      image: new Uint8Array([1, 2, 3]),
    });

    assertResultSucceeded(result);
  });
});

describe('ComfyUI adapter privacy', () => {
  it('computes privacy preflight correctly', () => {
    const adapter = createComfyUIAdapter(DEFAULT_CONFIG, [IMAGE_UPSCALE_TEMPLATE]);
    const request = createTestRequest('image.upscale', {
      image: new Uint8Array([1, 2, 3]),
    });

    const preflight = computePrivacyPreflight(request, adapter);
    expect(preflight.dataLeavesDevice).toBe(true);
    expect(preflight.requiresUserApproval).toBe(true);
    expect(preflight.providerId).toBe('joy.comfyui');
  });
});

describe('ComfyUI adapter error handling', () => {
  it('handles null input gracefully', async () => {
    const adapter = createComfyUIAdapter(DEFAULT_CONFIG, [IMAGE_UPSCALE_TEMPLATE]);
    const result = await adapter.invoke('image.upscale', null);

    expect(result.status).toBe('failed');
    expect(result.diagnostics.some((d) => d.code === 'MISSING_REQUIRED_INPUT')).toBe(true);
  });

  it('generates unique request IDs', async () => {
    const adapter = createComfyUIAdapter(DEFAULT_CONFIG, [IMAGE_UPSCALE_TEMPLATE]);
    const result1 = await adapter.invoke('image.upscale', { image: new Uint8Array([1]) });
    const result2 = await adapter.invoke('image.upscale', { image: new Uint8Array([2]) });

    expect(result1.requestId).not.toBe(result2.requestId);
  });
});

describe('Built-in templates', () => {
  it('IMAGE_UPSCALE_TEMPLATE has correct structure', () => {
    expect(IMAGE_UPSCALE_TEMPLATE.templateId).toBe('image-upscale-v1');
    expect(IMAGE_UPSCALE_TEMPLATE.capability).toBe('image.upscale');
    expect(IMAGE_UPSCALE_TEMPLATE.inputs).toHaveLength(2);
    expect(IMAGE_UPSCALE_TEMPLATE.outputs).toHaveLength(1);
    expect(IMAGE_UPSCALE_TEMPLATE.requiredModels).toContain('RealESRGAN_x4plus.pth');
  });

  it('BACKGROUND_REMOVAL_TEMPLATE has correct structure', () => {
    expect(BACKGROUND_REMOVAL_TEMPLATE.templateId).toBe('background-removal-v1');
    expect(BACKGROUND_REMOVAL_TEMPLATE.capability).toBe('image.removeBackground');
    expect(BACKGROUND_REMOVAL_TEMPLATE.inputs).toHaveLength(2);
    expect(BACKGROUND_REMOVAL_TEMPLATE.outputs).toHaveLength(2);
    expect(BACKGROUND_REMOVAL_TEMPLATE.requiredModels).toContain('u2net.onnx');
  });
});
