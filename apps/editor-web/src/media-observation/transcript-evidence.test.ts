import { describe, expect, it } from 'vitest';
import {
  TranscriptEvidenceError,
  createTranscriptEvidence,
  isTranscriptEligibleForUserObservation,
  mapTranscriptEvidenceToComposition,
} from './transcript-evidence.js';

const ASSET_DIGEST = 'a'.repeat(64);

describe('transcript evidence', () => {
  it('keeps timestamped words and maps them through an explicit composition mapping', () => {
    const evidence = createTranscriptEvidence({
      assetDigest: ASSET_DIGEST,
      origin: 'user',
      language: 'en-US',
      sourceRange: { startUs: 0, endUs: 1_000_000 },
      provenance: {
        providerId: 'owner-selected-asr',
        modelId: 'whisper-small',
        delivery: 'direct-byok',
        createdAt: '2026-09-06T00:00:00.000Z',
      },
      words: [
        { text: 'hello', startUs: 100_000, endUs: 300_000, confidence: 0.9 },
        { text: 'world', startUs: 300_000, endUs: 600_000, speakerId: 'speaker-1' },
      ],
    });

    expect(isTranscriptEligibleForUserObservation(evidence)).toBe(true);
    expect(evidence.words.map((word) => word.id)).toEqual([
      `transcript-word:v1:${ASSET_DIGEST}:0:100000-300000`,
      `transcript-word:v1:${ASSET_DIGEST}:1:300000-600000`,
    ]);
    expect(
      mapTranscriptEvidenceToComposition(evidence, {
        compositionStartUs: 2_000_000,
        compositionDurationUs: 1_000_000,
        sourceAnchorUs: 0,
        direction: 'forward',
        sourcePerComposition: { numerator: 1, denominator: 1 },
      }).words,
    ).toEqual([
      expect.objectContaining({
        text: 'hello',
        compositionStartUs: 2_100_000,
        compositionEndUs: 2_300_000,
      }),
      expect.objectContaining({
        text: 'world',
        compositionStartUs: 2_300_000,
        compositionEndUs: 2_600_000,
      }),
    ]);
  });

  it('never lets reference-fixture speech satisfy a user-media observation claim', () => {
    const evidence = createTranscriptEvidence({
      assetDigest: ASSET_DIGEST,
      origin: 'reference',
      language: 'fa-IR',
      sourceRange: { startUs: 0, endUs: 1_000_000 },
      provenance: {
        providerId: 'fixture',
        modelId: 'fixture-asr-v1',
        delivery: 'reference-fixture',
        createdAt: '2026-09-06T00:00:00.000Z',
      },
      words: [{ text: 'سلام', startUs: 0, endUs: 300_000 }],
    });

    expect(isTranscriptEligibleForUserObservation(evidence)).toBe(false);
  });

  it('rejects unordered, out-of-range, or unsafe-provenance transcript input', () => {
    const base = {
      assetDigest: ASSET_DIGEST,
      origin: 'user' as const,
      language: 'en-US',
      sourceRange: { startUs: 0, endUs: 1_000_000 },
      provenance: {
        providerId: 'owner-asr',
        modelId: 'model-v1',
        delivery: 'local' as const,
        createdAt: '2026-09-06T00:00:00.000Z',
      },
    };
    expect(() =>
      createTranscriptEvidence({
        ...base,
        words: [
          { text: 'later', startUs: 600_000, endUs: 700_000 },
          { text: 'earlier', startUs: 500_000, endUs: 600_000 },
        ],
      }),
    ).toThrow(TranscriptEvidenceError);
    expect(() =>
      createTranscriptEvidence({
        ...base,
        words: [{ text: 'outside', startUs: 900_000, endUs: 1_100_000 }],
      }),
    ).toThrow(TranscriptEvidenceError);
    expect(() =>
      createTranscriptEvidence({
        ...base,
        provenance: { ...base.provenance, providerId: 'https://not-an-opaque-provider' },
        words: [{ text: 'safe speech is data', startUs: 0, endUs: 10_000 }],
      }),
    ).toThrow(TranscriptEvidenceError);
  });

  it('maps reverse playback as an ordered composition interval without inventing uncovered words', () => {
    const evidence = createTranscriptEvidence({
      assetDigest: ASSET_DIGEST,
      origin: 'user',
      language: 'en-US',
      sourceRange: { startUs: 0, endUs: 1_200_000 },
      provenance: {
        providerId: 'local-asr',
        modelId: 'model-v1',
        delivery: 'local',
        createdAt: '2026-09-06T00:00:00.000Z',
      },
      words: [
        { text: 'inside', startUs: 300_000, endUs: 500_000 },
        { text: 'outside', startUs: 900_000, endUs: 1_100_000 },
      ],
    });

    const mapped = mapTranscriptEvidenceToComposition(evidence, {
      compositionStartUs: 0,
      compositionDurationUs: 1_000_000,
      sourceAnchorUs: 1_000_000,
      direction: 'reverse',
      sourcePerComposition: { numerator: 1, denominator: 1 },
    });
    expect(mapped.words).toEqual([
      expect.objectContaining({
        text: 'inside',
        compositionStartUs: 500_000,
        compositionEndUs: 700_000,
      }),
    ]);
    expect(mapped.omittedWordIds).toHaveLength(1);
  });
});
