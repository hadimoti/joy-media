import { describe, expect, it } from 'vitest';
import type { AssetRecordV1 } from '@joy-media/project-schema';
import {
  JOY_PRIMARY_OBSERVATION_STREAM_ID,
  JOY_SOURCE_OBSERVATION_ANALYSIS_VERSION,
  observationMetadataForAsset,
} from './observation-host-factory.js';

const digest = 'a'.repeat(64);
const video: AssetRecordV1 = {
  id: 'asset-1',
  kind: 'video',
  displayName: 'Intro.mp4',
  sha256: digest,
  descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000, width: 1920, height: 1080 },
};

describe('JOY observation host metadata', () => {
  it('creates a bounded primary-track source descriptor only from complete video facts', () => {
    expect(observationMetadataForAsset(video)).toEqual({
      assetId: 'asset-1',
      assetDigest: digest,
      kind: 'video',
      durationUs: 1_000_000,
      streamCount: 1,
      streamId: JOY_PRIMARY_OBSERVATION_STREAM_ID,
      sourceVariant: {
        crop: { x: 0, y: 0, width: 1920, height: 1080 },
        rotationDeg: 0,
        representation: 'original',
        analysisVersion: JOY_SOURCE_OBSERVATION_ANALYSIS_VERSION,
      },
    });
  });

  it('fails closed for incomplete or non-video assets', () => {
    const { sha256: _digest, ...missingDigest } = video;
    const invalidAssets: readonly AssetRecordV1[] = [
      missingDigest,
      { ...video, descriptor: { ...video.descriptor!, durationUs: 0 } },
      { ...video, descriptor: { mimeType: 'video/mp4', durationUs: 1 } },
      { ...video, kind: 'image' },
    ];
    for (const asset of invalidAssets) expect(observationMetadataForAsset(asset)).toBeUndefined();
  });

  it('does not attach a transcript, provider, source location, or mutable descriptor', () => {
    const metadata = observationMetadataForAsset(video);
    expect(metadata).toBeDefined();
    expect(JSON.stringify(metadata)).not.toMatch(/transcript|https?:|blob:|file:|provider/i);
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata?.sourceVariant)).toBe(true);
  });
});
