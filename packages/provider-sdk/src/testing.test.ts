import { describe, expect, it } from 'vitest';
import {
  createMockProvider,
  validateManifest,
  createTestRequest,
  assertResultSucceeded,
  simulateProviderFailure,
} from './testing.js';
import { ProviderUnavailableError } from './errors.js';
import type { ProviderManifestV2 } from './types.js';

describe('createMockProvider', () => {
  it('creates a provider with specified capabilities', () => {
    const provider = createMockProvider('test', ['speech.transcribe', 'image.generate']);

    expect(provider.manifest.id).toBe('test');
    expect(provider.manifest.capabilities).toHaveLength(2);
    expect(provider.manifest.capabilities[0]!.id).toBe('speech.transcribe');
    expect(provider.manifest.capabilities[1]!.id).toBe('image.generate');
  });

  it('uses default execution and privacy', () => {
    const provider = createMockProvider('test', ['speech.transcribe']);

    expect(provider.manifest.execution).toBe('worker-local');
    expect(provider.manifest.privacy.dataLeavesDevice).toBe(false);
  });

  it('accepts custom execution and privacy', () => {
    const provider = createMockProvider('test', ['speech.transcribe'], {
      execution: 'remote-api',
      privacy: { dataLeavesDevice: true },
    });

    expect(provider.manifest.execution).toBe('remote-api');
    expect(provider.manifest.privacy.dataLeavesDevice).toBe(true);
  });

  it('invokes successfully by default', async () => {
    const provider = createMockProvider('test', ['speech.transcribe']);
    const result = await provider.invoke('speech.transcribe', {});

    expect(result.status).toBe('succeeded');
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });
});

describe('validateManifest', () => {
  it('validates a correct manifest', () => {
    const manifest: ProviderManifestV2 = {
      protocolVersion: 2,
      id: 'test',
      displayName: 'Test Provider',
      adapterVersion: '1.0.0',
      execution: 'worker-local',
      capabilities: [
        {
          id: 'speech.transcribe',
          inputSchema: {},
          outputSchema: {},
        },
      ],
      configurationSchema: {},
      secretFields: [],
      privacy: { dataLeavesDevice: false },
    };

    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects non-object manifest', () => {
    const result = validateManifest('not an object');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Manifest must be an object');
  });

  it('rejects invalid protocolVersion', () => {
    const manifest = {
      protocolVersion: 1,
      id: 'test',
      displayName: 'Test',
      adapterVersion: '1.0.0',
      execution: 'worker-local',
      capabilities: [],
      configurationSchema: {},
      secretFields: [],
      privacy: { dataLeavesDevice: false },
    };

    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('protocolVersion must be 2');
  });

  it('rejects empty id', () => {
    const manifest = {
      protocolVersion: 2,
      id: '',
      displayName: 'Test',
      adapterVersion: '1.0.0',
      execution: 'worker-local',
      capabilities: [],
      configurationSchema: {},
      secretFields: [],
      privacy: { dataLeavesDevice: false },
    };

    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('id must be a non-empty string');
  });

  it('rejects invalid execution', () => {
    const manifest = {
      protocolVersion: 2,
      id: 'test',
      displayName: 'Test',
      adapterVersion: '1.0.0',
      execution: 'invalid',
      capabilities: [],
      configurationSchema: {},
      secretFields: [],
      privacy: { dataLeavesDevice: false },
    };

    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('execution must be one of'))).toBe(true);
  });

  it('rejects invalid capabilities', () => {
    const manifest = {
      protocolVersion: 2,
      id: 'test',
      displayName: 'Test',
      adapterVersion: '1.0.0',
      execution: 'worker-local',
      capabilities: [{ id: 123 }],
      configurationSchema: {},
      secretFields: [],
      privacy: { dataLeavesDevice: false },
    };

    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('capabilities[0].id must be a string'))).toBe(
      true,
    );
  });

  it('rejects invalid privacy', () => {
    const manifest = {
      protocolVersion: 2,
      id: 'test',
      displayName: 'Test',
      adapterVersion: '1.0.0',
      execution: 'worker-local',
      capabilities: [],
      configurationSchema: {},
      secretFields: [],
      privacy: { dataLeavesDevice: 'invalid' },
    };

    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('privacy.dataLeavesDevice must be boolean or "depends"');
  });
});

describe('createTestRequest', () => {
  it('creates a request with unique idempotency keys', () => {
    const request1 = createTestRequest('speech.transcribe', {});
    const request2 = createTestRequest('speech.transcribe', {});

    expect(request1.idempotencyKey).not.toBe(request2.idempotencyKey);
  });

  it('creates a request with correct capability', () => {
    const request = createTestRequest('image.generate', { prompt: 'test' });

    expect(request.capability).toBe('image.generate');
    expect(request.input).toEqual({ prompt: 'test' });
    expect(request.requestVersion).toBe(1);
  });
});

describe('assertResultSucceeded', () => {
  it('does not throw for succeeded result', async () => {
    const provider = createMockProvider('test', ['speech.transcribe']);
    const result = await provider.invoke('speech.transcribe', {});

    expect(() => assertResultSucceeded(result)).not.toThrow();
  });

  it('throws for failed result', async () => {
    const provider = createMockProvider('test', ['speech.transcribe']);
    const failedProvider = simulateProviderFailure(provider, 'invalid-output');
    const result = await failedProvider.invoke('speech.transcribe', {});

    expect(() => assertResultSucceeded(result)).toThrow(
      "Expected result status 'succeeded', got 'failed'",
    );
  });
});

describe('simulateProviderFailure', () => {
  it('simulates unavailable error', async () => {
    const provider = createMockProvider('test', ['speech.transcribe']);
    const failedProvider = simulateProviderFailure(provider, 'unavailable');

    await expect(failedProvider.invoke('speech.transcribe', {})).rejects.toThrow(
      ProviderUnavailableError,
    );
  });

  it('simulates timeout error', async () => {
    const provider = createMockProvider('test', ['speech.transcribe']);
    const failedProvider = simulateProviderFailure(provider, 'timeout');

    await expect(failedProvider.invoke('speech.transcribe', {})).rejects.toThrow(
      'Simulated timeout',
    );
  });

  it('simulates invalid output', async () => {
    const provider = createMockProvider('test', ['speech.transcribe']);
    const failedProvider = simulateProviderFailure(provider, 'invalid-output');

    const result = await failedProvider.invoke('speech.transcribe', {});
    expect(result.status).toBe('failed');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.code).toBe('INVALID_OUTPUT');
  });
});
