import type { CommandTransaction } from '@joy-media/commands';
import type { JoyProjectV1, SpikeProject, VisualObjectV1 } from '@joy-media/project-schema';
import { bindClipToObject } from './sticker-bindings.js';
import { withTimelineElementKinds } from './timeline-element-kind.js';
import { upsertUniversalTimelineBinding } from './universal-placement.js';

export interface CaptionLayerInsertion {
  readonly label: string;
  readonly clipId: string;
  readonly documentId: string;
  readonly timeline: CommandTransaction;
  readonly project: JoyProjectV1;
}

/** Creates the visual caption document and its editable CC timeline lane atomically. */
export function buildCaptionLayerInsertion({
  timeline,
  project,
  token,
}: {
  readonly timeline: SpikeProject;
  readonly project: JoyProjectV1;
  readonly token: string;
}): CaptionLayerInsertion {
  const timelineComposition = timeline.compositions[timeline.rootCompositionId];
  const visualComposition = project.compositions[project.rootCompositionId];
  if (timelineComposition === undefined || visualComposition === undefined) {
    throw new Error('The main composition is unavailable.');
  }
  const durationUs = Math.max(1_000_000, timelineComposition.durationUs);
  const clipId = `caption-${token}`;
  const documentId = `captions-${token}`;
  const objectId = `caption-controller-${token}`;
  const assetId = 'joy-caption-layer';
  const label = 'Add CC captions layer';
  const order =
    timelineComposition.tracks.reduce((max, track) => Math.max(max, track.order), -1) + 1;
  const controller: VisualObjectV1 = {
    id: objectId,
    kind: 'null',
    assetId,
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    },
  };
  const withCaptions: JoyProjectV1 = {
    ...project,
    updatedAt: new Date().toISOString(),
    assets: {
      ...project.assets,
      [assetId]: project.assets[assetId] ?? {
        id: assetId,
        kind: 'other',
        displayName: 'CC Captions',
      },
    },
    visualObjects: { ...project.visualObjects, [objectId]: controller },
    captionDocuments: {
      ...project.captionDocuments,
      [documentId]: {
        id: documentId,
        language: 'en-US',
        direction: 'auto',
        speakers: [],
        words: {},
        segments: [],
      },
    },
    compositions: {
      ...project.compositions,
      [visualComposition.id]: {
        ...visualComposition,
        tracks: [
          ...visualComposition.tracks,
          {
            id: `caption-track-${token}`,
            kind: 'caption',
            name: 'Captions',
            order:
              visualComposition.tracks.reduce((max, track) => Math.max(max, track.order), -1) + 1,
            enabled: true,
            locked: false,
            clips: [
              {
                id: clipId,
                kind: 'caption',
                startUs: 0,
                durationUs,
                captionDocumentId: documentId,
              },
            ],
          },
        ],
      },
    },
  };
  const nextProject = upsertUniversalTimelineBinding(
    withTimelineElementKinds(bindClipToObject(withCaptions, clipId, objectId), {
      [clipId]: 'caption',
    }),
    {
      id: clipId,
      compositionId: timelineComposition.id,
      trackId: `Captions-${token}`,
      elementKind: 'caption',
      startUs: 0,
      durationUs,
      source: { kind: 'caption', id: documentId },
    },
  );
  return {
    label,
    clipId,
    documentId,
    project: nextProject,
    timeline: {
      label,
      commands: [
        {
          type: 'timeline.addTrack',
          payload: {
            compositionId: timelineComposition.id,
            track: {
              id: `Captions-${token}`,
              kind: 'video',
              family: 'visual',
              name: 'Captions',
              order,
              enabled: true,
              clips: [],
            },
          },
        },
        {
          type: 'timeline.insertClip',
          payload: {
            compositionId: timelineComposition.id,
            trackId: `Captions-${token}`,
            clip: {
              id: clipId,
              kind: 'video',
              assetId,
              startUs: 0,
              durationUs,
              sourceInUs: 0,
            },
          },
        },
      ],
    },
  };
}
