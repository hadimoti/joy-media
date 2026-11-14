import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { canonicalBindingKey } from '@joy-media/project-schema';
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
  buildTimelineCutPlan,
  buildTimelinePastePlan,
  copyTimelineClips,
  projectIdsInUse,
  timelinePastePlacements,
  type TimelineClipClipboardData,
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

describe('timeline clip state paste (look and keyframes)', () => {
  const look = {
    x: 120,
    y: -40,
    scaleX: 0.5,
    scaleY: 0.75,
    rotationDeg: 15,
    opacity: 0.6,
    crop: { left: 0.1, top: 0.05, right: 0, bottom: 0.2 },
  };

  /** A product clip whose controller has a non-default look and one opacity keyframe curve. */
  function lookFixture() {
    const timeline = buildReferenceSpikeProject();
    const root = timeline.compositions.root!;
    const sourceClip = root.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === 'product')!;
    expect(sourceClip.kind).toBe('video');
    const assetId = sourceClip.kind === 'video' ? sourceClip.assetId : 'unused';
    const sourceControllerId = `media-controller-${sourceClip.id}`;
    const animation = {
      binding: {
        ownerKind: 'clip' as const,
        ownerId: sourceClip.id,
        propertyId: 'opacity',
        timeDomain: 'clip-local' as const,
      },
      value: {
        kind: 'scalar' as const,
        curve: {
          keyframes: [
            { timeUs: 0, value: 0, interpolation: 'linear' as const },
            { timeUs: 1_000_000, value: 1, interpolation: 'linear' as const },
          ],
        },
      },
    };
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
              transform: look,
            },
          },
          propertyAnimations: { [canonicalBindingKey(animation.binding)]: animation },
        },
        sourceClip.id,
        sourceControllerId,
      ),
      sourceClip.id,
      'image',
    );
    return { timeline, root, visual, sourceClip, sourceControllerId };
  }

  const clipAnimations = (session: EditorSession, clipId: string) =>
    Object.values(session.visualProject.propertyAnimations ?? {}).filter(
      (animation) => animation.binding.ownerKind === 'clip' && animation.binding.ownerId === clipId,
    );

  /** The animations of one clip, re-owned to another clip id. */
  const retargeted = (animations: ReturnType<typeof clipAnimations>, clipId: string) =>
    animations.map((animation) => ({
      binding: { ...animation.binding, ownerId: clipId },
      value: animation.value,
    }));

  /** Pastes a clipboard at the playhead through the same path the App uses. */
  function pasteClipboard(
    session: EditorSession,
    clipboard: TimelineClipClipboardData,
    playheadUs: number,
    id: string,
  ): string {
    const root = session.timelineProject.compositions.root!;
    const plan = buildTimelinePastePlan({
      composition: root,
      clipboard,
      playheadUs,
      reservedIds: projectIdsInUse(session.timelineProject, session.visualProject),
      idGenerator: () => id,
    });
    if (!plan.ok) throw new Error(plan.reason);
    applyTimelineMediaPlacement(
      session,
      audioStateFromProject(session.visualProject),
      plan.transaction,
      timelinePastePlacements(plan.pastes, session.visualProject.assets, {
        width: root.width,
        height: root.height,
      }),
      plan.pastes.map((paste) => ({
        sourceClipId: paste.sourceClipId,
        clipId: paste.clipId,
        ...(paste.state === undefined ? {} : { state: paste.state }),
      })),
    );
    return plan.pastedClipIds[0]!;
  }

  it('gives the pasted controller the source transform, crop and opacity, and re-creates its keyframes', () => {
    const { timeline, root, visual, sourceClip, sourceControllerId } = lookFixture();
    const session = new EditorSession(memoryStorage(), timeline, visual);
    const sourceAnimations = clipAnimations(session, sourceClip.id);
    expect(sourceAnimations).toHaveLength(1);

    const clipboard = copyTimelineClips(root, [sourceClip.id], visual)!;
    const pastedId = pasteClipboard(session, clipboard, root.durationUs + 1_000_000, 'pasted-look');
    const controllerId = `media-controller-${pastedId}`;

    expect(readClipObjectMap(session.visualProject)[pastedId]).toBe(controllerId);
    expect(session.visualProject.visualObjects[controllerId]?.transform).toEqual(
      session.visualProject.visualObjects[sourceControllerId]?.transform,
    );
    expect(session.visualProject.visualObjects[controllerId]?.transform).toEqual(look);
    expect(clipAnimations(session, pastedId)).toEqual(retargeted(sourceAnimations, pastedId));
    expect(clipAnimations(session, sourceClip.id)).toEqual(sourceAnimations);
  });

  it('keeps the keyframes and the controller look when a cut clip is pasted', () => {
    const { timeline, root, visual, sourceClip } = lookFixture();
    const session = new EditorSession(memoryStorage(), timeline, visual);
    const sourceAnimations = clipAnimations(session, sourceClip.id);

    const cut = buildTimelineCutPlan({
      composition: root,
      selectedClipIds: [sourceClip.id],
      visualProject: visual,
    });
    if (!cut.ok) throw new Error(cut.reason);
    applyTimelineMediaPlacement(session, audioStateFromProject(visual), cut.transaction, []);
    expect(clipAnimations(session, sourceClip.id)).toHaveLength(0);

    const pastedId = pasteClipboard(
      session,
      cut.clipboard,
      root.durationUs + 1_000_000,
      'pasted-cut',
    );
    const controllerId = `media-controller-${pastedId}`;

    expect(session.visualProject.visualObjects[controllerId]?.transform).toEqual(look);
    expect(clipAnimations(session, pastedId)).toEqual(retargeted(sourceAnimations, pastedId));
  });

  it('undoes a media paste as one step: the clip, its controller and its keyframes', () => {
    const { timeline, root, visual, sourceClip } = lookFixture();
    const session = new EditorSession(memoryStorage(), timeline, visual);
    const clipboard = copyTimelineClips(root, [sourceClip.id], visual)!;
    const pastedId = pasteClipboard(session, clipboard, root.durationUs + 1_000_000, 'pasted-undo');
    const controllerId = `media-controller-${pastedId}`;
    const clipIds = () =>
      session.timelineProject.compositions
        .root!.tracks.flatMap((track) => track.clips)
        .map((clip) => clip.id);
    expect(clipIds()).toContain(pastedId);
    expect(clipAnimations(session, pastedId)).toHaveLength(1);

    session.undo();

    expect(clipIds()).not.toContain(pastedId);
    expect(session.visualProject.visualObjects[controllerId]).toBeUndefined();
    expect(readClipObjectMap(session.visualProject)[pastedId]).toBeUndefined();
    expect(clipAnimations(session, pastedId)).toHaveLength(0);
    expect(clipAnimations(session, sourceClip.id)).toHaveLength(1);

    session.redo();

    expect(clipIds()).toContain(pastedId);
    expect(session.visualProject.visualObjects[controllerId]?.transform).toEqual(look);
    expect(clipAnimations(session, pastedId)).toHaveLength(1);
  });
});
