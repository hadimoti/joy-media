import { describe, expect, it } from 'vitest';
import {
  assertFrameIdentity,
  assertObservationFinding,
  createCompositionEvidenceIdentity,
  createSourceEvidenceIdentity,
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
    expect(frameIdentityKey(first)).toBe(
      `source-frame:v1:${'a'.repeat(64)}:video-0:12:9000:timebase-1-90000`,
    );
  });

  it('rejects negative, non-integer, and overflow timing instead of rounding it into evidence', () => {
    expect(() => ptsTicksToSourceTimeUs('-1', 1, 90_000)).toThrow('ptsTicks');
    expect(() => ptsTicksToSourceTimeUs('1.5', 1, 90_000)).toThrow('ptsTicks');
    expect(() => ptsTicksToSourceTimeUs('1'.repeat(65), 1, 90_000)).toThrow('ptsTicks');
    expect(() => ptsTicksToSourceTimeUs('9007199254740992', 1, 1)).toThrow('safe integer');
  });

  it('rejects invalid privacy origins, frame-end overflow, and unbounded composition dependencies', () => {
    const frame = {
      assetDigest: 'a'.repeat(64),
      streamId: 'video-0',
      presentationIndex: 0,
      ptsTicks: '0',
      timebaseNumerator: 1,
      timebaseDenominator: 1,
      sourceTimeUs: 0,
      durationUs: 1,
    };
    expect(() => createSourceEvidenceIdentity('remote-upload' as never, frame)).toThrow('origin');
    expect(() =>
      assertFrameIdentity({
        ...frame,
        sourceTimeUs: Number.MAX_SAFE_INTEGER,
        durationUs: 1,
        ptsTicks: String(Number.MAX_SAFE_INTEGER),
        timebaseDenominator: 1_000_000,
      }),
    ).toThrow('frame end');
    expect(() =>
      createCompositionEvidenceIdentity({
        compositionId: 'composition-1',
        projectRevision: 'revision-1',
        outputTimeUs: 0,
        rendererVersion: 'renderer-v1',
        evaluatorVersion: 'evaluator-v1',
        dependencyDigests: Array.from({ length: 257 }, () => 'a'.repeat(64)),
      }),
    ).toThrow('dependencyDigests');
  });

  it('accepts only bounded, evidence-linked findings without raw locations', () => {
    const finding = {
      id: 'finding-1',
      kind: 'text' as const,
      evidenceFrameIds: ['frame-1'],
      confidence: 'medium' as const,
      uncertainty: 'OCR could be incomplete.',
    };
    expect(() => assertObservationFinding(finding)).not.toThrow();
    expect(() =>
      assertObservationFinding({ ...finding, uncertainty: 'file:///private/project.mov' }),
    ).toThrow('uncertainty');
    expect(() =>
      assertObservationFinding({ ...finding, uncertainty: 'See https://example.test/frame.' }),
    ).toThrow('uncertainty');
    expect(() =>
      assertObservationFinding({
        ...finding,
        evidenceFrameIds: Array.from({ length: 257 }, (_, index) => `frame-${index}`),
      }),
    ).toThrow('evidenceFrameIds');
    expect(() => assertObservationFinding({ ...finding, id: 'C:private-file' })).toThrow(
      'finding.id',
    );
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

  it('rejects raw paths from composition evidence identities', () => {
    expect(() =>
      createCompositionEvidenceIdentity({
        compositionId: 'relative/path',
        projectRevision: 'revision-1',
        outputTimeUs: 0,
        rendererVersion: 'renderer-v1',
        evaluatorVersion: 'evaluator-v1',
        dependencyDigests: [],
      }),
    ).toThrow('compositionId');
  });
});
