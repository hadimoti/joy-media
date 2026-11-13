import { describe, expect, it } from 'vitest';
import type { AssetRecordV1, JoyProjectV1, TransitionV1 } from '@joy-media/project-schema';
import { emptySpikeProject, makeVideoClip, SECOND_US, withClips } from '@joy-media/test-fixtures';
import type { MissingMediaEntry } from './missing-media.js';
import {
  exportLacksVisualSource,
  formatMissingExportRange,
  missingExportClipIds,
  missingExportClips,
  transitionsWithoutMissingClips,
} from './export-missing-media.js';
import { activePreparedExportClipsAt } from './export-media-readiness.js';
import { activeTransitionAt, transitionClipTimes } from './preview-frame-helpers.js';

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

describe('exportLacksVisualSource (T-R04 all-missing export)', () => {
  it('stops an export that has nothing to draw when no clip is missing', () => {
    expect(exportLacksVisualSource(0, false, 0)).toBe(true);
  });

  it('lets an export run when every used clip is missing and the owner accepted that', () => {
    // Both clips are missing: no sourced visual clip is left, but the export is allowed.
    const project = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-a', 0, SECOND_US, { assetId: 'asset-a' }),
      makeVideoClip('clip-b', SECOND_US, SECOND_US, { assetId: 'asset-b' }),
    ]);
    const missing = missingExportClips(project, [entry('asset-a'), entry('asset-b')]);
    const missingIds = missingExportClipIds(missing);

    expect(missingIds.size).toBe(2);
    expect(exportLacksVisualSource(0, false, missingIds.size)).toBe(false);
  });

  it('still runs an export that has sourced clips or HTML scenes', () => {
    expect(exportLacksVisualSource(1, false, 0)).toBe(false);
    expect(exportLacksVisualSource(0, true, 0)).toBe(false);
  });
});

describe('transitions with a missing clip (T-R04)', () => {
  // Left clip (present) 0 to 1 s, right clip (missing) 1 to 2 s; a 0.5 s transition at the cut.
  const timeline = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
    makeVideoClip('clip-left', 0, SECOND_US, { assetId: 'asset-left' }),
    makeVideoClip('clip-right', SECOND_US, SECOND_US, { assetId: 'asset-missing' }),
  ]);
  const transition: TransitionV1 = {
    id: 't-1',
    trackId: 'track-0',
    leftClipId: 'clip-left',
    rightClipId: 'clip-right',
    type: 'fade',
    durationUs: SECOND_US / 2,
  };
  const visual = { transitions: [transition] } as unknown as JoyProjectV1;
  const clipTimes = transitionClipTimes(timeline);
  const missingIds = new Set(['clip-right']);

  it('is the transition the preview would draw, so dropping it is needed', () => {
    expect(activeTransitionAt(visual, 0.75 * SECOND_US, clipTimes)).toBe(transition);
  });

  it('drops a transition whose partner clip is missing, and keeps the others', () => {
    const kept = transitionsWithoutMissingClips([transition], missingIds);
    const keptProject = { transitions: kept } as unknown as JoyProjectV1;
    expect(kept).toEqual([]);
    expect(activeTransitionAt(keptProject, 0.75 * SECOND_US, clipTimes)).toBeUndefined();

    const sourced = { ...transition, id: 't-2', rightClipId: 'clip-present' };
    expect(transitionsWithoutMissingClips([transition, sourced], missingIds)).toEqual([sourced]);
  });

  it('keeps the transition list as it is when no clip is missing', () => {
    expect(transitionsWithoutMissingClips([transition], new Set())).toEqual([transition]);
  });

  it('lets the present clip play as a plain cut past the missing partner, without a crash', () => {
    const media = new Map([['clip-left', { video: {} }]]);
    const clips = timeline.compositions[timeline.rootCompositionId]!.tracks[0]!.clips;
    const sourced = clips.filter((clip) => !missingIds.has(clip.id));
    const activeIds = (timeUs: number) =>
      activePreparedExportClipsAt(sourced, timeUs, media).map((clip) => clip.id);

    expect(activeIds(0.75 * SECOND_US)).toEqual(['clip-left']);
    expect(activeIds(1.5 * SECOND_US)).toEqual([]);
  });
});
