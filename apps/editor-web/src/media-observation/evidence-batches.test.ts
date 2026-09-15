import { describe, expect, it } from 'vitest';
import {
  createEvidenceBatches,
  missingEvidenceFrameIds,
  type EvidenceBatchProgress,
} from './evidence-batches.js';

const intended = Array.from({ length: 100 }, (_, index) => `frame-${index}`);

describe('evidence batches', () => {
  it('resumes an interrupted exhaustive request with only missing temporal identities', () => {
    const reviewed = intended.slice(0, 60);
    expect(missingEvidenceFrameIds(intended, reviewed)).toEqual(intended.slice(60));
    expect(
      createEvidenceBatches(intended, { maxFramesPerBatch: 25, reviewedFrameIds: reviewed }),
    ).toEqual([
      { id: 'evidence-batch-0', frameIds: intended.slice(60, 85) },
      { id: 'evidence-batch-1', frameIds: intended.slice(85) },
    ]);
  });

  it('keeps submitted-but-failed frames unreviewed and does not inflate retry totals', () => {
    const progress: EvidenceBatchProgress = {
      intendedFrameIds: ['still-a@0', 'still-a@1', 'flash'],
      submittedFrameIds: ['still-a@0', 'still-a@1', 'flash'],
      reviewedFrameIds: ['still-a@0'],
    };
    expect(missingEvidenceFrameIds(progress.intendedFrameIds, progress.reviewedFrameIds)).toEqual([
      'still-a@1',
      'flash',
    ]);
    expect(
      createEvidenceBatches(progress.intendedFrameIds, {
        maxFramesPerBatch: 10,
        reviewedFrameIds: [...progress.reviewedFrameIds, 'still-a@0'],
      }),
    ).toEqual([{ id: 'evidence-batch-0', frameIds: ['still-a@1', 'flash'] }]);
  });

  it('accepts the canonical source-frame identity format for exhaustive batches', () => {
    const sourceFrameId = `source-frame:v1:${'a'.repeat(64)}:video-0:0:0:timebase-1-30`;
    expect(
      createEvidenceBatches([sourceFrameId], { maxFramesPerBatch: 1, reviewedFrameIds: [] }),
    ).toEqual([{ id: 'evidence-batch-0', frameIds: [sourceFrameId] }]);
  });

  it('accepts the O1 512-character opaque identity bound and rejects a longer frame id', () => {
    const maxLengthFrameId = `f${'a'.repeat(511)}`;
    const tooLongFrameId = `f${'a'.repeat(512)}`;
    expect(
      createEvidenceBatches([maxLengthFrameId], { maxFramesPerBatch: 1, reviewedFrameIds: [] }),
    ).toEqual([{ id: 'evidence-batch-0', frameIds: [maxLengthFrameId] }]);
    expect(() =>
      createEvidenceBatches([tooLongFrameId], { maxFramesPerBatch: 1, reviewedFrameIds: [] }),
    ).toThrow('bounded opaque identifier');
  });

  it('keeps O1 raw-location rejection when expanding the source-frame identifier bound', () => {
    for (const unsafeFrameId of ['https:provider-frame', 'data:private-frame', 'C:frame'])
      expect(() =>
        createEvidenceBatches([unsafeFrameId], { maxFramesPerBatch: 1, reviewedFrameIds: [] }),
      ).toThrow('bounded opaque identifier');
  });
});
