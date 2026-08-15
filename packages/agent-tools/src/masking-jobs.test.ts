import { describe, expect, it } from 'vitest';
import { createMaskAgentJobRequest } from './masking-jobs.js';

describe('Joy Code masking jobs', () => {
  it('creates a replayable async request without paths or model credentials', () => {
    const request = createMaskAgentJobRequest({
      sourceKind: 'video',
      assetId: 'video-1',
      sourceSha256: 'a'.repeat(64),
      settings: {
        schemaVersion: 1,
        provider: 'sam2-grounded',
        selection: { mode: 'prompt', prompt: 'red bicycle' },
        edge: { featherPx: 2, expansionPx: 0, detail: 0.8, decontaminate: true },
        invert: false,
        output: 'cutout',
        video: { range: 'clip', direction: 'both', temporalConsistency: 0.9 },
      },
    });
    expect(request).toMatchObject({
      jobType: 'mask.video',
      inputAssetId: 'video-1',
      generation: {
        providerId: 'local-worker',
        modelId: 'sam2-grounded',
        modelVersion: 'joy.masking.v1',
        prompt: 'red bicycle',
      },
    });
    expect(JSON.stringify(request)).not.toMatch(/[A-Z]:\\|\/Users\/|token|secret/i);
  });
});
