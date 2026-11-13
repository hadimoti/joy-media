import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession } from './editor-session.js';
import {
  bindClipToObject,
  readClipMediaKindMap,
  readClipObjectMap,
  writeClipMediaKind,
} from './sticker-bindings.js';
import { buildTimelineClipReplaceTransaction } from './timeline-clip-interaction.js';
import {
  buildTimelinePastePlan,
  copyTimelineClips,
  projectIdsInUse,
  timelinePastePlacements,
} from './timeline-clip-clipboard.js';
import { audioStateFromProject } from './timeline-presentation.js';
import { applyTimelineMediaPlacement } from './timeline-media-placement.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('timeline media placement history', () => {
  it('undoes and redoes a media replacement with its visual binding and source kind', () => {
    const sourceTimeline = buildReferenceSpikeProject();
    const root = sourceTimeline.compositions.root!;
    const sourceTrack = root.tracks.find((track) =>
      track.clips.some((clip) => clip.id === 'product'),
    )!;
    const sourceClip = sourceTrack.clips.find((clip) => clip.id === 'product')!;
    const clipId = sourceClip.id;
    const originalAssetId = 'original-product-image';
    const replacementAssetId = 'replacement-product-video';
    const timeline = {
      ...sourceTimeline,
      compositions: {
        ...sourceTimeline.compositions,
        root: {
          ...root,
          tracks: root.tracks.map((track) =>
            track.id === sourceTrack.id
              ? {
                  ...track,
                  clips: track.clips.map((clip) =>
                    clip.id === clipId && clip.kind === 'video'
                      ? { ...clip, assetId: originalAssetId }
                      : clip,
                  ),
                }
              : track,
          ),
        },
      },
    };
    const controllerId = `media-controller-${clipId}`;
    const originalBinding = {
      ...INITIAL_EDITOR_PROJECT.visualObjects['product-image']!,
      id: controllerId,
      assetId: originalAssetId,
    };
    const initialVisual = writeClipMediaKind(
      bindClipToObject(
        {
          ...INITIAL_EDITOR_PROJECT,
          assets: {
            ...INITIAL_EDITOR_PROJECT.assets,
            [originalAssetId]: {
              id: originalAssetId,
              kind: 'image',
              displayName: 'Original product image',
            },
          },
          visualObjects: {
            ...INITIAL_EDITOR_PROJECT.visualObjects,
            [controllerId]: originalBinding,
          },
        },
        clipId,
        controllerId,
      ),
      clipId,
      'image',
    );
    const session = new EditorSession(memoryStorage(), timeline, initialVisual);
    const transaction = buildTimelineClipReplaceTransaction({
      composition: timeline.compositions.root!,
      trackId: sourceTrack.id,
      clip: sourceClip.kind === 'video' ? { ...sourceClip, assetId: originalAssetId } : sourceClip,
      assetId: replacementAssetId,
      displayName: 'Replacement product video',
    });
    expect(transaction).toBeDefined();
    if (transaction === undefined) return;

    applyTimelineMediaPlacement(session, audioStateFromProject(initialVisual), transaction, [
      {
        clipId,
        asset: {
          id: replacementAssetId,
          kind: 'video',
          displayName: 'Replacement product video',
          descriptor: { mimeType: 'video/mp4' },
        },
      },
    ]);

    session.undo();

    const undoneClip = session.timelineProject.compositions
      .root!.tracks.flatMap((track) => track.clips)
      .find((clip) => clip.id === clipId);
    expect(undoneClip).toMatchObject({ id: clipId, assetId: originalAssetId });
    expect(readClipObjectMap(session.visualProject)[clipId]).toBe(controllerId);
    expect(session.visualProject.visualObjects[controllerId]?.assetId).toBe(originalAssetId);
    expect(readClipMediaKindMap(session.visualProject)[clipId]).toBe('image');

    session.redo();

    const redoneClip = session.timelineProject.compositions
      .root!.tracks.flatMap((track) => track.clips)
      .find((clip) => clip.id === clipId);
    expect(redoneClip).toMatchObject({ id: clipId, assetId: replacementAssetId });
    expect(session.visualProject.visualObjects[controllerId]?.assetId).toBe(replacementAssetId);
    expect(readClipMediaKindMap(session.visualProject)[clipId]).toBe('video');
  });
});

describe('timeline paste history', () => {
  /** A copy of the reference product clip, pasted after the end of the timeline. */
  function pasteFixture(placeMedia: boolean) {
    const timeline = buildReferenceSpikeProject();
    const root = timeline.compositions.root!;
    const sourceClip = root.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === 'product')!;
    expect(sourceClip.kind).toBe('video');
    const assetId = sourceClip.kind === 'video' ? sourceClip.assetId : 'unused';
    const sourceControllerId = `media-controller-${sourceClip.id}`;
    const visual = writeClipMediaKind(
      bindClipToObject(
        {
          ...INITIAL_EDITOR_PROJECT,
          assets: {
            ...INITIAL_EDITOR_PROJECT.assets,
            [assetId]: { id: assetId, kind: 'image', displayName: 'Product still' },
          },
          visualObjects: {
            ...INITIAL_EDITOR_PROJECT.visualObjects,
            [sourceControllerId]: {
              ...INITIAL_EDITOR_PROJECT.visualObjects['product-image']!,
              id: sourceControllerId,
              assetId,
            },
          },
        },
        sourceClip.id,
        sourceControllerId,
      ),
      sourceClip.id,
      'image',
    );
    const clipboard = copyTimelineClips(root, [sourceClip.id])!;
    const plan = buildTimelinePastePlan({
      composition: root,
      clipboard,
      playheadUs: root.durationUs + 1_000_000,
      reservedIds: projectIdsInUse(timeline, visual),
      idGenerator: () => 'pasted-product',
    });
    if (!plan.ok) throw new Error(plan.reason);
    const placements = placeMedia
      ? timelinePastePlacements(plan.pastes, visual.assets, {
          width: root.width,
          height: root.height,
        })
      : [];
    const session = new EditorSession(memoryStorage(), timeline, visual);
    applyTimelineMediaPlacement(
      session,
      audioStateFromProject(visual),
      plan.transaction,
      placements,
      plan.pastes.map((paste) => ({ sourceClipId: paste.sourceClipId, clipId: paste.clipId })),
    );
    return { session, pastedId: plan.pastedClipIds[0]!, sourceClipId: sourceClip.id };
  }

  const pastedClipOf = (session: EditorSession, clipId: string) =>
    session.timelineProject.compositions
      .root!.tracks.flatMap((track) => track.clips)
      .find((clip) => clip.id === clipId);

  it('pastes a media clip with its fresh controller and kind, and undoes and redoes both together', () => {
    const { session, pastedId } = pasteFixture(true);
    const controllerId = `media-controller-${pastedId}`;

    expect(pastedClipOf(session, pastedId)).toBeDefined();
    expect(readClipObjectMap(session.visualProject)[pastedId]).toBe(controllerId);
    expect(session.visualProject.visualObjects[controllerId]).toBeDefined();
    expect(readClipMediaKindMap(session.visualProject)[pastedId]).toBe('image');

    session.undo();
    expect(pastedClipOf(session, pastedId)).toBeUndefined();
    expect(session.visualProject.visualObjects[controllerId]).toBeUndefined();
    expect(readClipObjectMap(session.visualProject)[pastedId]).toBeUndefined();

    session.redo();
    expect(pastedClipOf(session, pastedId)).toBeDefined();
    expect(session.visualProject.visualObjects[controllerId]).toBeDefined();
    expect(readClipObjectMap(session.visualProject)[pastedId]).toBe(controllerId);
  });

  it('copies the source clip-object binding when no media is placed, as Duplicate does', () => {
    const { session, pastedId, sourceClipId } = pasteFixture(false);
    expect(pastedClipOf(session, pastedId)).toBeDefined();
    expect(readClipObjectMap(session.visualProject)[pastedId]).toBe(
      readClipObjectMap(session.visualProject)[sourceClipId],
    );
  });

  it('places media only for video clips whose asset is a real image, video or audio', () => {
    const clip = (id: string, assetId: string) => ({
      id,
      kind: 'video' as const,
      assetId,
      startUs: 0,
      durationUs: 1_000_000,
      sourceInUs: 0,
    });
    const pastes = [
      { clipId: 'p-image', sourceClipId: 's', trackId: 't', clip: clip('p-image', 'img') },
      { clipId: 'p-lut', sourceClipId: 's', trackId: 't', clip: clip('p-lut', 'lut') },
      { clipId: 'p-missing', sourceClipId: 's', trackId: 't', clip: clip('p-missing', 'gone') },
      {
        clipId: 'p-comp',
        sourceClipId: 's',
        trackId: 't',
        clip: {
          id: 'p-comp',
          kind: 'composition' as const,
          compositionId: 'c',
          startUs: 0,
          durationUs: 1,
          childOffsetUs: 0,
        },
      },
    ];
    const assets = {
      img: { id: 'img', kind: 'image' as const, displayName: 'Still' },
      lut: { id: 'lut', kind: 'lut' as const, displayName: 'Grade' },
    };
    const placements = timelinePastePlacements(pastes, assets, { width: 1920, height: 1080 });
    expect(placements.map((placement) => placement.clipId)).toEqual(['p-image']);
    expect(placements[0]?.frame).toEqual({ width: 1920, height: 1080 });
  });
});
