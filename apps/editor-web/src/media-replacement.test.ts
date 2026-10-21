import { describe, expect, it } from 'vitest';
import type { AssetRecordV1 } from '@joy-media/project-schema';
import { validateSpikeProject } from '@joy-media/project-schema';
import { applyTransaction } from '@joy-media/commands';
import { emptySpikeProject, makeVideoClip, SECOND_US, withClips } from '@joy-media/test-fixtures';
import {
  buildReplacementAsset,
  repointClipsTransaction,
  sha256OfBlob,
} from './media-replacement.js';

const originalRecord: AssetRecordV1 = {
  id: 'asset-clip-a',
  kind: 'video',
  displayName: 'clip-a.mp4',
  sha256: 'a'.repeat(64),
  bytes: 10,
  descriptor: { mimeType: 'video/mp4', durationUs: 2 * SECOND_US },
};

describe('buildReplacementAsset', () => {
  it('gives the replacement its own checksum and length and leaves the original untouched', async () => {
    const before = structuredClone(originalRecord);
    const file = new Blob([new TextEncoder().encode('new clip!')], { type: 'video/mp4' });
    const replacement = await buildReplacementAsset(originalRecord, 'asset-replacement-1', file);
    expect(replacement).toMatchObject({
      id: 'asset-replacement-1',
      kind: 'video',
      bytes: 9,
      sha256: await sha256OfBlob(file),
    });
    expect(replacement.sha256).not.toBe(originalRecord.sha256);
    expect(replacement.displayName).toBe('clip-a.mp4 (replacement)');
    expect(originalRecord).toEqual(before);
  });
});

describe('repointClipsTransaction', () => {
  it('repoints every video clip that uses the original, across compositions and tracks', () => {
    let project = emptySpikeProject({ trackCount: 2 });
    project = withClips(project, 'track-0', [
      makeVideoClip('clip-1', 0, SECOND_US, { assetId: 'asset-clip-a' }),
    ]);
    project = withClips(project, 'track-1', [
      makeVideoClip('clip-2', 0, SECOND_US, { assetId: 'asset-clip-a' }),
      makeVideoClip('clip-3', SECOND_US, SECOND_US, { assetId: 'asset-other' }),
    ]);
    const transaction = repointClipsTransaction(
      project,
      'asset-clip-a',
      'asset-replacement-1',
      'Use different file',
    );
    expect(transaction.commands).toHaveLength(2);
    const result = applyTransaction(project, transaction).project;
    const clips = result.compositions['root']!.tracks.flatMap((track) => track.clips);
    expect(clips.find((clip) => clip.id === 'clip-1')).toMatchObject({
      assetId: 'asset-replacement-1',
    });
    expect(clips.find((clip) => clip.id === 'clip-2')).toMatchObject({
      assetId: 'asset-replacement-1',
    });
    expect(clips.find((clip) => clip.id === 'clip-3')).toMatchObject({ assetId: 'asset-other' });
    expect(validateSpikeProject(result)).toEqual([]);
  });

  it('is empty when no clip uses the original', () => {
    const project = withClips(emptySpikeProject(), 'track-0', [
      makeVideoClip('clip-1', 0, SECOND_US, { assetId: 'asset-other' }),
    ]);
    expect(
      repointClipsTransaction(project, 'asset-clip-a', 'asset-replacement-1', 'x').commands,
    ).toEqual([]);
  });

  it('undoes as one step: the inverse of the transaction restores every original reference', () => {
    let project = emptySpikeProject({ trackCount: 1 });
    project = withClips(project, 'track-0', [
      makeVideoClip('clip-1', 0, SECOND_US, { assetId: 'asset-clip-a' }),
      makeVideoClip('clip-2', SECOND_US, SECOND_US, { assetId: 'asset-clip-a' }),
    ]);
    const { project: relinked, record } = applyTransaction(
      project,
      repointClipsTransaction(project, 'asset-clip-a', 'asset-replacement-1', 'Use different file'),
    );
    const undone = applyTransaction(relinked, { label: 'undo', commands: record.inverses }).project;
    expect(
      undone.compositions['root']!.tracks[0]!.clips.map((clip) =>
        clip.kind === 'video' ? clip.assetId : undefined,
      ),
    ).toEqual(['asset-clip-a', 'asset-clip-a']);
  });
});
