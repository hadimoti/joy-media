import { describe, expect, it } from 'vitest';
import {
  EvidenceStoreQuotaError,
  createEvidenceStore,
  type EvidenceManifestScope,
  type ObservationEvidenceIdentity,
} from './evidence-store.js';

const identity = (
  overrides: Partial<ObservationEvidenceIdentity> = {},
): ObservationEvidenceIdentity => ({
  projectId: 'project-1',
  assetDigest: 'a'.repeat(64),
  projectRevision: 'revision-1',
  modelId: 'openrouter/model-a',
  promptPolicyDigest: 'prompt-policy-v1',
  ...overrides,
});

const scope = (overrides: Partial<EvidenceManifestScope> = {}): EvidenceManifestScope => ({
  runId: 'run-1',
  identity: identity(),
  ...overrides,
});

const firstPage = Array.from({ length: 512 }, (_, index) => `source-frame-${index}`);
const secondPage = ['source-frame-512'];

describe('evidence store', () => {
  it('keeps bounded coverage pages while verifying whole-manifest exhaustive completion', () => {
    const store = createEvidenceStore();
    const manifestScope = scope();
    const manifest = store.createManifest({
      id: 'manifest-1',
      scope: manifestScope,
      mode: 'exhaustive',
      intendedFrameIdPages: [firstPage, secondPage],
      derivedMetadata: { transcriptState: 'unavailable', sampled: false },
    });

    expect(manifest.persistence).toBe('ephemeral');
    expect(manifest.intendedFrameCount).toBe(513);
    expect(manifest.derivedMetadata).toEqual({ transcriptState: 'unavailable', sampled: false });

    for (const stage of ['decoded', 'submitted', 'reviewed'] as const) {
      store.recordFrames({
        manifestId: manifest.id,
        scope: manifestScope,
        stage,
        frameIds: firstPage,
      });
      store.recordFrames({
        manifestId: manifest.id,
        scope: manifestScope,
        stage,
        frameIds: secondPage,
      });
    }
    store.setStatus({ manifestId: manifest.id, scope: manifestScope, status: 'complete' });

    const firstCoverage = store.readCoveragePage({
      manifestId: manifest.id,
      scope: manifestScope,
      pageIndex: 0,
    });
    const secondCoverage = store.readCoveragePage({
      manifestId: manifest.id,
      scope: manifestScope,
      pageIndex: 1,
    });

    expect(firstCoverage?.intendedFrameIds).toHaveLength(512);
    expect(firstCoverage?.reviewedFrameIds).toHaveLength(512);
    expect(secondCoverage?.intendedFrameIds).toEqual(secondPage);
    expect(secondCoverage?.summary).toMatchObject({
      intendedFrameCount: 513,
      decodedFrameCount: 513,
      submittedFrameCount: 513,
      reviewedFrameCount: 513,
      exhaustiveInput: true,
      modelComprehensionGuaranteed: false,
    });
  });

  it('uses an explicit metadata-only persistence preference and never exposes original payload storage', () => {
    const store = createEvidenceStore();
    const manifest = store.createManifest({
      id: 'persistent-analysis',
      scope: scope(),
      mode: 'overview',
      intendedFrameIdPages: [['source-frame-1']],
      persistence: 'project-local-metadata',
      derivedMetadata: { transcriptState: 'stored-locally' },
    });

    expect(manifest.persistence).toBe('project-local-metadata');
    expect(manifest.derivedMetadata).toEqual({ transcriptState: 'stored-locally' });
    expect(manifest).not.toHaveProperty('bytes');
    expect(manifest).not.toHaveProperty('original');
    expect(() =>
      store.createManifest({
        id: 'reject-original-payload',
        scope: scope({ runId: 'run-2' }),
        mode: 'overview',
        intendedFrameIdPages: [['source-frame-2']],
        original: new Uint8Array([1]),
      } as never),
    ).toThrow('only metadata fields');
  });

  it('fails closed when an evidence read does not match its asset, revision, model, or prompt policy', () => {
    const store = createEvidenceStore();
    const manifestScope = scope();
    store.createManifest({
      id: 'identity-bound',
      scope: manifestScope,
      mode: 'focus',
      intendedFrameIdPages: [['source-frame-1']],
    });

    for (const mismatchedIdentity of [
      identity({ assetDigest: 'b'.repeat(64) }),
      identity({ projectRevision: 'revision-2' }),
      identity({ modelId: 'openrouter/model-b' }),
      identity({ promptPolicyDigest: 'prompt-policy-v2' }),
    ]) {
      expect(
        store.readCoveragePage({
          manifestId: 'identity-bound',
          scope: { runId: manifestScope.runId, identity: mismatchedIdentity },
          pageIndex: 0,
        }),
      ).toBeUndefined();
    }
  });

  it('only clears derived analysis on user intent after the matching project has no active review', () => {
    const store = createEvidenceStore();
    const activeScope = scope();
    store.createManifest({
      id: 'active-review',
      scope: activeScope,
      mode: 'overview',
      intendedFrameIdPages: [['source-frame-1']],
    });
    store.createManifest({
      id: 'other-project',
      scope: scope({ identity: identity({ projectId: 'project-2' }), runId: 'run-2' }),
      mode: 'overview',
      intendedFrameIdPages: [['source-frame-2']],
    });

    expect(() =>
      store.clearProject({ projectId: 'project-1', intent: 'model-cleanup' as never }),
    ).toThrow('user intent');
    let activeReviewFailure: unknown;
    try {
      store.clearProject({ projectId: 'project-1', intent: 'user-request' });
    } catch (error) {
      activeReviewFailure = error;
    }
    expect(activeReviewFailure).toMatchObject({
      code: 'JOY_EVIDENCE_REVIEW_ACTIVE',
    });
    expect(() => store.assertProjectClearable('project-1')).toThrow('active');
    expect(store.readManifest({ manifestId: 'active-review', scope: activeScope })).toBeDefined();

    store.setStatus({ manifestId: 'active-review', scope: activeScope, status: 'cancelled' });
    expect(store.clearProject({ projectId: 'project-1', intent: 'user-request' })).toEqual({
      clearedManifestCount: 1,
    });
    expect(store.readManifest({ manifestId: 'active-review', scope: activeScope })).toBeUndefined();
    expect(
      store.readManifest({
        manifestId: 'other-project',
        scope: scope({ identity: identity({ projectId: 'project-2' }), runId: 'run-2' }),
      }),
    ).toBeDefined();
  });

  it('reports metadata quota failures structurally without partially publishing a manifest', () => {
    const store = createEvidenceStore({ maxManifestCount: 1 });
    store.createManifest({
      id: 'first',
      scope: scope(),
      mode: 'overview',
      intendedFrameIdPages: [['source-frame-1']],
    });

    let failure: unknown;
    try {
      store.createManifest({
        id: 'second',
        scope: scope({ runId: 'run-2' }),
        mode: 'overview',
        intendedFrameIdPages: [['source-frame-2']],
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(EvidenceStoreQuotaError);
    expect(failure).toMatchObject({
      code: 'JOY_EVIDENCE_QUOTA_EXCEEDED',
      quota: 'manifest-count',
      limit: 1,
      current: 1,
      requested: 1,
    });
    expect(
      store.readManifest({ manifestId: 'second', scope: scope({ runId: 'run-2' }) }),
    ).toBeUndefined();
  });
});
