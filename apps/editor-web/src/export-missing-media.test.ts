import { describe, expect, it } from 'vitest';
import type { AssetRecordV1 } from '@joy-media/project-schema';
import { emptySpikeProject, makeVideoClip, SECOND_US, withClips } from '@joy-media/test-fixtures';
import type { MissingMediaEntry } from './missing-media.js';
import {
  formatMissingExportRange,
  missingExportClipIds,
  missingExportClips,
} from './export-missing-media.js';

function entry(assetId: string, displayName = `${assetId}.mp4`): MissingMediaEntry {
  const record: AssetRecordV1 = {
    id: assetId,
    kind: 'video',
    displayName,
    sha256: 'a'.repeat(64),
    bytes: 4,
    descriptor: { mimeType: 'video/mp4' },
  };
  return { assetId, record };
}

describe('missingExportClips (T-R04 pre-export list)', () => {
  it('lists only the clips whose file is missing, with their root-timeline range', () => {
    const project = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-present', 0, SECOND_US, { assetId: 'asset-present' }),
      makeVideoClip('clip-missing', 2 * SECOND_US, 3 * SECOND_US, { assetId: 'asset-missing' }),
    ]);

    const clips = missingExportClips(project, [entry('asset-missing', 'intro.mp4')]);

    expect(clips).toEqual([
      {
        clipId: 'clip-missing',
        assetId: 'asset-missing',
        name: 'intro.mp4',
        startUs: 2 * SECOND_US,
        endUs: 5 * SECOND_US,
      },
    ]);
  });

  it('lists every clip that uses the same missing file, in timeline order', () => {
    const project = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-late', 4 * SECOND_US, SECOND_US, { assetId: 'asset-missing' }),
      makeVideoClip('clip-early', 0, SECOND_US, { assetId: 'asset-missing' }),
    ]);

    const clips = missingExportClips(project, [entry('asset-missing')]);

    expect(clips.map((clip) => clip.clipId)).toEqual(['clip-early', 'clip-late']);
  });

  it('returns nothing when no file is missing, or when no clip uses a missing file', () => {
    const project = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-1', 0, SECOND_US, { assetId: 'asset-1' }),
    ]);

    expect(missingExportClips(project, [])).toEqual([]);
    expect(missingExportClips(project, [entry('asset-elsewhere')])).toEqual([]);
  });

  it('exposes the clip ids, so the export can leave those clips out of its sources', () => {
    const project = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-a', 0, SECOND_US, { assetId: 'asset-missing' }),
      makeVideoClip('clip-b', SECOND_US, SECOND_US, { assetId: 'asset-present' }),
    ]);
    const clips = missingExportClips(project, [entry('asset-missing')]);

    expect([...missingExportClipIds(clips)]).toEqual(['clip-a']);
  });

  it('formats the range as timecodes at the project frame rate', () => {
    const clip = {
      clipId: 'clip-1',
      assetId: 'asset-missing',
      name: 'intro.mp4',
      startUs: 3 * SECOND_US,
      endUs: 3 * SECOND_US + 500_000,
    };

    expect(formatMissingExportRange(clip, 30)).toBe('00:00:03:00 - 00:00:03:15');
  });
});
