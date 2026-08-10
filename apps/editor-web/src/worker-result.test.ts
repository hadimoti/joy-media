import { describe, expect, it } from 'vitest';
import { verifyWorkerAudioDerivative } from './worker-result.js';

describe('verifyWorkerAudioDerivative', () => {
  it('verifies bytes and creates a stable generated asset descriptor', async () => {
    const bytes = new TextEncoder().encode('verified audio');
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    const result = await verifyWorkerAudioDerivative({
      jobId: 'job-audio-1',
      sourceAssetId: 'asset-source',
      derivative: {
        id: 'derivative-job-audio-1',
        projectId: 'project-1',
        assetId: 'asset-source',
        kind: 'audio',
        profile: 'audio-processed',
        sha256: digest,
        bytes: bytes.byteLength,
        descriptor: { mimeType: 'audio/wav', durationUs: 1_000_000 },
        availability: 'available-cloud',
        verifiedAt: Date.now(),
      },
      blob: new Blob([bytes], { type: 'audio/wav' }),
      now: '2026-08-10T00:00:00.000Z',
    });
    expect(result.generatedAsset).toMatchObject({
      id: 'processed-job-audio-1',
      kind: 'audio',
      sha256: digest,
      generationProvenance: {
        providerId: 'local-worker',
        generatedAssetId: 'processed-job-audio-1',
      },
    });
  });

  it('fails closed when the receipt digest is wrong', async () => {
    const bytes = new TextEncoder().encode('wrong result');
    await expect(
      verifyWorkerAudioDerivative({
        jobId: 'job-audio-2',
        sourceAssetId: 'asset-source',
        derivative: {
          id: 'derivative-job-audio-2',
          projectId: 'project-1',
          assetId: 'asset-source',
          kind: 'audio',
          profile: 'audio-processed',
          sha256: '0'.repeat(64),
          bytes: bytes.byteLength,
          descriptor: { mimeType: 'audio/wav' },
          availability: 'available-cloud',
          verifiedAt: Date.now(),
        },
        blob: new Blob([bytes], { type: 'audio/wav' }),
      }),
    ).rejects.toThrow('SHA-256');
  });
});
