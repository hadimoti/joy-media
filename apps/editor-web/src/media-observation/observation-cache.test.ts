import { describe, expect, it } from 'vitest';
import {
  ObservationCacheQuotaError,
  createObservationCache,
  type ObservationCacheIdentity,
} from './observation-cache.js';
import { createEvidenceStore } from './evidence-store.js';

const identity = (overrides: Partial<ObservationCacheIdentity> = {}): ObservationCacheIdentity => ({
  projectId: 'project-1',
  assetDigest: 'a'.repeat(64),
  projectRevision: 'revision-1',
  modelId: 'openrouter/model-a',
  promptPolicyDigest: 'prompt-policy-v1',
  streamId: 'video-0',
  crop: { x: 0, y: 0, width: 1920, height: 1080 },
  rotationDeg: 0,
  representation: 'original',
  analysisVersion: 'observation-v1',
  ...overrides,
});

const firstFrameId = 'source-frame:v1:frame-0';
const secondFrameId = 'source-frame:v1:frame-1';
const firstBytes = Uint8Array.from([1, 2, 3]);
const byteDigest = 'b'.repeat(64);

describe('observation cache', () => {
  it('deduplicates byte storage without collapsing distinct temporal frame identities', () => {
    const cache = createObservationCache({ maxBytes: 16 });
    const cacheIdentity = identity();
    const payload = Uint8Array.from([1, 2, 3]);
    cache.put({
      identity: cacheIdentity,
      temporalFrameId: firstFrameId,
      byteDigest,
      bytes: payload,
    });
    cache.put({
      identity: cacheIdentity,
      temporalFrameId: secondFrameId,
      byteDigest,
      bytes: payload,
    });
    payload[0] = 88;

    expect(cache.stats()).toEqual({
      temporalIdentityCount: 2,
      uniqueByteEntryCount: 1,
      usedBytes: 3,
      maxBytes: 16,
    });
    expect(cache.read({ identity: cacheIdentity, temporalFrameId: firstFrameId })?.bytes).toEqual(
      firstBytes,
    );
    expect(cache.read({ identity: cacheIdentity, temporalFrameId: secondFrameId })?.bytes).toEqual(
      Uint8Array.from([1, 2, 3]),
    );

    const returned = cache.read({ identity: cacheIdentity, temporalFrameId: firstFrameId })!;
    returned.bytes[0] = 99;
    expect(cache.read({ identity: cacheIdentity, temporalFrameId: firstFrameId })?.bytes).toEqual(
      Uint8Array.from([1, 2, 3]),
    );
  });

  it('fails closed on asset, revision, model, or prompt-policy mismatches', () => {
    const cache = createObservationCache({ maxBytes: 16 });
    const cacheIdentity = identity();
    cache.put({
      identity: cacheIdentity,
      temporalFrameId: firstFrameId,
      byteDigest,
      bytes: firstBytes,
    });

    for (const mismatchedIdentity of [
      identity({ assetDigest: 'c'.repeat(64) }),
      identity({ projectRevision: 'revision-2' }),
      identity({ modelId: 'openrouter/model-b' }),
      identity({ promptPolicyDigest: 'prompt-policy-v2' }),
    ])
      expect(
        cache.read({ identity: mismatchedIdentity, temporalFrameId: firstFrameId }),
      ).toBeUndefined();
  });

  it('keeps source representation variants separate while deduplicating their identical bytes', () => {
    const cache = createObservationCache({ maxBytes: 16 });
    const sourceFrameId = 'source-frame:v1:shared-presentation';
    const original = identity();
    const proxyCrop = identity({
      representation: 'proxy',
      crop: { x: 100, y: 200, width: 640, height: 360 },
      rotationDeg: 90,
      analysisVersion: 'observation-v2',
    });

    cache.put({
      identity: original,
      temporalFrameId: sourceFrameId,
      byteDigest,
      bytes: firstBytes,
    });
    cache.put({
      identity: proxyCrop,
      temporalFrameId: sourceFrameId,
      byteDigest,
      bytes: firstBytes,
    });

    expect(cache.stats()).toMatchObject({
      temporalIdentityCount: 2,
      uniqueByteEntryCount: 1,
      usedBytes: 3,
    });
    expect(cache.read({ identity: original, temporalFrameId: sourceFrameId })).toBeDefined();
    expect(cache.read({ identity: proxyCrop, temporalFrameId: sourceFrameId })).toBeDefined();
  });

  it('reports quota rejection structurally and leaves the cache unchanged', () => {
    const cache = createObservationCache({ maxBytes: 3 });
    const cacheIdentity = identity();
    cache.put({
      identity: cacheIdentity,
      temporalFrameId: firstFrameId,
      byteDigest,
      bytes: firstBytes,
    });

    let failure: unknown;
    try {
      cache.put({
        identity: cacheIdentity,
        temporalFrameId: secondFrameId,
        byteDigest: 'd'.repeat(64),
        bytes: Uint8Array.from([4]),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ObservationCacheQuotaError);
    expect(failure).toMatchObject({
      code: 'JOY_OBSERVATION_CACHE_QUOTA_EXCEEDED',
      requestedBytes: 1,
      usedBytes: 3,
      maxBytes: 3,
    });
    expect(cache.stats().temporalIdentityCount).toBe(1);
    expect(cache.read({ identity: cacheIdentity, temporalFrameId: secondFrameId })).toBeUndefined();
  });

  it('accepts only user-requested project-scoped cache eviction and blocks active-review cleanup', () => {
    const cacheIdentity = identity();
    const evidenceStore = createEvidenceStore();
    const activeScope = {
      runId: 'active-run',
      identity: {
        projectId: cacheIdentity.projectId,
        assetDigest: cacheIdentity.assetDigest,
        projectRevision: cacheIdentity.projectRevision,
        modelId: cacheIdentity.modelId,
        promptPolicyDigest: cacheIdentity.promptPolicyDigest,
      },
    };
    evidenceStore.createManifest({
      id: 'active-manifest',
      scope: activeScope,
      mode: 'overview',
      intendedFrameIdPages: [['source-frame-1']],
    });
    const cache = createObservationCache({
      maxBytes: 16,
      assertProjectClearable: evidenceStore.assertProjectClearable,
    });
    cache.put({
      identity: cacheIdentity,
      temporalFrameId: firstFrameId,
      byteDigest,
      bytes: firstBytes,
    });

    expect(() =>
      cache.clearProject({
        projectId: 'project-1',
        intent: 'model-cleanup' as never,
      }),
    ).toThrow('user intent');
    let activeReviewFailure: unknown;
    try {
      cache.clearProject({ projectId: 'project-1', intent: 'user-request' });
    } catch (error) {
      activeReviewFailure = error;
    }
    expect(activeReviewFailure).toMatchObject({ code: 'JOY_EVIDENCE_REVIEW_ACTIVE' });
    expect(cache.read({ identity: cacheIdentity, temporalFrameId: firstFrameId })).toBeDefined();

    evidenceStore.setStatus({
      manifestId: 'active-manifest',
      scope: activeScope,
      status: 'cancelled',
    });

    expect(
      cache.clearProject({
        projectId: 'project-1',
        intent: 'user-request',
      }),
    ).toEqual({ clearedTemporalIdentityCount: 1 });
    expect(cache.read({ identity: cacheIdentity, temporalFrameId: firstFrameId })).toBeUndefined();
  });
});
