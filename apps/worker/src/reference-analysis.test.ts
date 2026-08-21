import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  analyzeReferenceVideo,
  ReferenceAnalysisError,
  validateReferenceAnalysisModelFindings,
} from './reference-analysis.js';
import type {
  ReferenceAnalysisFinding,
  VideoReferenceAnalyzeReceipt,
} from '@joy-media/job-protocol';

const SOURCE = join(
  process.cwd(),
  'apps',
  'editor-web',
  'public',
  'media',
  'reference',
  'asset-intro.mp4',
);

describe('reference analysis', () => {
  it('produces bounded deterministic evidence from the redistributable fixture', async () => {
    const receipt = await analyzeReferenceVideo({
      jobId: 'reference-job-1',
      assetId: 'asset-intro',
      sourcePath: SOURCE,
      payload: {
        assetId: 'asset-intro',
        maxDurationUs: 30_000_000,
        maxBytes: 2_000_000,
        sampleCount: 3,
        maxAudioBeats: 4,
      },
      cancelled: () => false,
      progress: async () => undefined,
    });

    expect(receipt).toMatchObject({
      kind: 'video.reference-analyze',
      assetId: 'asset-intro',
      bytes: 1_054_138,
      descriptor: {
        mimeType: 'video/mp4',
        width: 320,
        height: 180,
        durationUs: 30_000_000,
      },
      summary: {
        shotCount: 1,
        cutCount: 0,
        sampleCount: 3,
        transcriptSegmentCount: 0,
      },
    });
    expect(receipt.evidenceIds).toEqual(receipt.evidence.map((evidence) => evidence.id));
    expect(receipt.evidence.filter((evidence) => evidence.kind === 'palette')).toHaveLength(3);
    expect(receipt.evidence.filter((evidence) => evidence.kind === 'composition')).toHaveLength(3);
    expect(receipt.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'shot-00000000',
          kind: 'shot',
          startUs: 0,
          durationUs: 30_000_000,
        }),
        expect.objectContaining({
          id: 'text-safe-zone-00000000',
          kind: 'text-safe-zone',
          safe: false,
        }),
        expect.objectContaining({
          id: 'transcript-00000000',
          kind: 'transcript',
          segments: [],
        }),
      ]),
    );
    expect(
      receipt.evidence
        .filter((evidence) => evidence.kind === 'audio-beat')
        .map((evidence) => ({
          startUs: evidence.startUs,
          durationUs: evidence.durationUs,
        })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ startUs: expect.any(Number), durationUs: 500_000 }),
      ]),
    );
  });

  it('fails closed when the source is too large or too long', async () => {
    await expect(
      analyzeReferenceVideo({
        jobId: 'reference-too-large',
        assetId: 'asset-intro',
        sourcePath: SOURCE,
        payload: {
          assetId: 'asset-intro',
          maxDurationUs: 30_000_000,
          maxBytes: 100,
        },
        cancelled: () => false,
        progress: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: 'REFERENCE_ANALYSIS_SOURCE_TOO_LARGE',
    });

    await expect(
      analyzeReferenceVideo({
        jobId: 'reference-too-long',
        assetId: 'asset-intro',
        sourcePath: SOURCE,
        payload: {
          assetId: 'asset-intro',
          maxDurationUs: 5_000_000,
          maxBytes: 2_000_000,
        },
        cancelled: () => false,
        progress: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: 'REFERENCE_ANALYSIS_SOURCE_TOO_LONG',
    });
  });

  it('cooperatively cancels before finishing expensive steps', async () => {
    let cancelled = false;
    await expect(
      analyzeReferenceVideo({
        jobId: 'reference-cancelled',
        assetId: 'asset-intro',
        sourcePath: SOURCE,
        payload: {
          assetId: 'asset-intro',
          maxDurationUs: 30_000_000,
          maxBytes: 2_000_000,
          sampleCount: 3,
        },
        cancelled: () => cancelled,
        progress: async (progress) => {
          if (progress >= 35) cancelled = true;
        },
      }),
    ).rejects.toMatchObject({
      code: 'REFERENCE_ANALYSIS_CANCELED',
    });
  });

  it('rejects model findings that cite missing or empty evidence', () => {
    const receipt: VideoReferenceAnalyzeReceipt = {
      kind: 'video.reference-analyze',
      assetId: 'asset-intro',
      sha256: 'a'.repeat(64),
      bytes: 1_054_138,
      descriptor: {
        mimeType: 'video/mp4',
        width: 320,
        height: 180,
        durationUs: 30_000_000,
      },
      summary: {
        shotCount: 1,
        cutCount: 0,
        averageShotDurationUs: 30_000_000,
        fastestShotDurationUs: 30_000_000,
        sampleCount: 1,
        transcriptSegmentCount: 0,
        audioBeatCount: 0,
      },
      evidence: [
        {
          id: 'shot-00000000',
          kind: 'shot',
          label: 'Shot 1',
          summary: 'Whole clip',
          startUs: 0,
          durationUs: 30_000_000,
        },
      ],
      evidenceIds: ['shot-00000000'],
    };

    expect(() =>
      validateReferenceAnalysisModelFindings(receipt, [
        {
          id: 'finding-empty',
          source: 'model',
          title: 'Unsupported',
          summary: 'No evidence attached',
          evidenceIds: [],
        },
      ]),
    ).toThrow(/evidence/i);

    expect(() =>
      validateReferenceAnalysisModelFindings(receipt, [
        {
          id: 'finding-missing',
          source: 'model',
          title: 'Unsupported',
          summary: 'Unknown evidence id',
          evidenceIds: ['missing-evidence'],
        },
      ]),
    ).toThrow(/missing-evidence/i);
  });

  it('keeps optional model findings only when they are evidence-backed', async () => {
    const receipt = await analyzeReferenceVideo({
      jobId: 'reference-model-1',
      assetId: 'asset-intro',
      sourcePath: SOURCE,
      payload: {
        assetId: 'asset-intro',
        maxDurationUs: 30_000_000,
        maxBytes: 2_000_000,
        sampleCount: 3,
      },
      cancelled: () => false,
      progress: async () => undefined,
      modelAnalyze: async (result): Promise<readonly ReferenceAnalysisFinding[]> => [
        {
          id: 'finding-1',
          source: 'model',
          title: 'Use as technical reference only',
          summary:
            'The burned-in timecode and edge-hugging title box make this a poor typography reference.',
          evidenceIds: ['text-safe-zone-00000000', result.evidenceIds[0]!],
        },
      ],
    });

    expect(receipt.findings).toEqual([
      expect.objectContaining({
        id: 'finding-1',
        source: 'model',
        evidenceIds: expect.arrayContaining(['text-safe-zone-00000000']),
      }),
    ]);
  });
});
