import { describe, expect, it } from 'vitest';
import { createMockProvider, simulateProviderFailure } from './testing.js';
import type { CapabilityRequest, CapabilityResult } from './types.js';

describe('Idempotency and Deduplication (§21.9)', () => {
  const createRequest = (idempotencyKey: string): CapabilityRequest => ({
    requestVersion: 1,
    capability: 'speech.transcribe',
    input: { assetId: 'test-asset' },
    constraints: {},
    idempotencyKey,
  });

  describe('idempotencyKey prevents duplication', () => {
    it('retry uses the same idempotencyKey', async () => {
      const provider = createMockProvider('test-provider', ['speech.transcribe']);
      const idempotencyKey = 'unique-key-12345';
      const request = createRequest(idempotencyKey);

      const result1 = await provider.invoke(request.capability, request.input);
      const result2 = await provider.invoke(request.capability, request.input);

      expect(result1.provenance.idempotencyKey).toBe(idempotencyKey);
      expect(result2.provenance.idempotencyKey).toBe(idempotencyKey);
    });

    it('failed request preserves idempotencyKey for retry', async () => {
      const provider = createMockProvider('test-provider', ['speech.transcribe']);
      const failedProvider = simulateProviderFailure(provider, 'invalid-output');
      const idempotencyKey = 'retry-key-67890';
      const request = createRequest(idempotencyKey);

      const failedResult = await failedProvider.invoke(request.capability, request.input);

      expect(failedResult.status).toBe('failed');
      expect(failedResult.provenance.idempotencyKey).toBe(idempotencyKey);
    });

    it('results are separate from project mutations', async () => {
      const provider = createMockProvider('test-provider', ['speech.transcribe']);
      const request = createRequest('separation-test-key');

      const result = await provider.invoke(request.capability, request.input);

      expect(result.requestId).toBeDefined();
      expect(result.provenance.idempotencyKey).toBe(request.idempotencyKey);
      expect(result.outputs).toBeDefined();
      expect(result.status).toBe('succeeded');

      const resultKeys = Object.keys(result);
      expect(resultKeys).not.toContain('projectId');
      expect(resultKeys).not.toContain('documentId');
      expect(resultKeys).not.toContain('timelineId');
    });

    it('multiple retries with same key produce consistent provenance', async () => {
      const provider = createMockProvider('test-provider', ['speech.transcribe']);
      const idempotencyKey = 'consistent-key-abc';
      const request = createRequest(idempotencyKey);

      const results: CapabilityResult[] = [];
      for (let i = 0; i < 3; i++) {
        results.push(await provider.invoke(request.capability, request.input));
      }

      const keys = results.map((r) => r.provenance.idempotencyKey);
      expect(keys.every((k) => k === idempotencyKey)).toBe(true);

      const providerIds = results.map((r) => r.provenance.providerId);
      expect(providerIds.every((id) => id === 'test-provider')).toBe(true);
    });

    it('canceled request preserves idempotencyKey', async () => {
      const provider = createMockProvider('test-provider', ['speech.transcribe']);
      const idempotencyKey = 'cancel-key-xyz';
      const request = createRequest(idempotencyKey);

      const result = await provider.invoke(request.capability, request.input);

      const canceledResult: CapabilityResult = {
        ...result,
        status: 'canceled',
      };

      expect(canceledResult.status).toBe('canceled');
      expect(canceledResult.provenance.idempotencyKey).toBe(idempotencyKey);
    });
  });

  describe('asset deduplication', () => {
    it('same idempotencyKey maps to same assetId', async () => {
      const provider = createMockProvider('test-provider', ['speech.transcribe']);
      const idempotencyKey = 'dedup-key-999';
      const request = createRequest(idempotencyKey);

      const result1 = await provider.invoke(request.capability, request.input);
      const result2 = await provider.invoke(request.capability, request.input);

      expect(result1.provenance.idempotencyKey).toBe(result2.provenance.idempotencyKey);
      expect(result1.provenance.requestHash).toBe(result2.provenance.requestHash);
    });

    it('different idempotencyKeys produce different requestHashes', async () => {
      const provider = createMockProvider('test-provider', ['speech.transcribe']);
      const request1 = createRequest('key-1');
      const request2 = createRequest('key-2');

      const result1 = await provider.invoke(request1.capability, request1.input);
      const result2 = await provider.invoke(request2.capability, request2.input);

      expect(result1.provenance.idempotencyKey).not.toBe(result2.provenance.idempotencyKey);
    });
  });
});
