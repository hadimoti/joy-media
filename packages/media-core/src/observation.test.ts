import { describe, expect, it } from 'vitest';
import {
  assertFrameIdentity,
  createCompositionEvidenceIdentity,
  frameIdentityKey,
  ptsTicksToSourceTimeUs,
} from './observation.js';

describe('observation identity', () => {
  it('derives source time from integer PTS and the stream timebase, not nominal frame rate', () => {
    expect(ptsTicksToSourceTimeUs('3003', 1, 90_000)).toBe(33_366);
    expect(ptsTicksToSourceTimeUs('180000', 1, 90_000)).toBe(2_000_000);
  });

  it('keeps duplicate PTS samples distinct by presentation index', () => {
    const first = {
      assetDigest: 'a'.repeat(64),
      streamId: 'video-0',
      presentationIndex: 12,
      ptsTicks: '9000',
      timebaseNumerator: 1,
      timebaseDenominator: 90_000,
      sourceTimeUs: 100_000,
      durationUs: 33_333,
    };
    const second = { ...first, presentationIndex: 13 };
    assertFrameIdentity(first);
    expect(frameIdentityKey(first)).not.toBe(frameIdentityKey(second));
  });

  it('rejects negative, non-integer, and overflow timing instead of rounding it into evidence', () => {
    expect(() => ptsTicksToSourceTimeUs('-1', 1, 90_000)).toThrow('ptsTicks');
    expect(() => ptsTicksToSourceTimeUs('1.5', 1, 90_000)).toThrow('ptsTicks');
    expect(() => ptsTicksToSourceTimeUs('9007199254740992', 1, 1)).toThrow('safe integer');
  });

  it('keeps composed output evidence distinct from a source frame identity', () => {
    expect(
      createCompositionEvidenceIdentity({
        compositionId: 'composition-1',
        projectRevision: 'local-revision:v1:project',
        outputTimeUs: 1_000_000,
        rendererVersion: 'renderer-v1',
        evaluatorVersion: 'evaluator-v1',
        dependencyDigests: ['a'.repeat(64)],
      }),
    ).toMatchObject({ kind: 'composition', outputTimeUs: 1_000_000 });
  });
});
