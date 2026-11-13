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
