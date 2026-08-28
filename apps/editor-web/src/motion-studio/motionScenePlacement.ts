import type { CommandTransaction } from '@joy-media/commands';
import type { JoyProjectV1, SpikeProject, VisualObjectV1 } from '@joy-media/project-schema';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import { allocateTimelineTrackId } from '../timeline-track-identity.js';

type TimelineComposition = NonNullable<
  SpikeProject['compositions'][SpikeProject['rootCompositionId']]
>;

export interface MotionScenePlacementPlan {
  readonly objectId: string;
  readonly clipId: string;
  readonly visualTransaction: VisualObjectTransaction;
  readonly timelineTransaction: CommandTransaction;
}

export function buildMotionScenePlacementPlan(input: {
  readonly composition: TimelineComposition;
  readonly visualProject: JoyProjectV1;
  readonly selectedClipId: string | undefined;
  readonly motionSceneId: string;
  readonly nowMs: number;
}): MotionScenePlacementPlan | undefined {
  const { composition, visualProject, selectedClipId, motionSceneId, nowMs } = input;
  if (selectedClipId === undefined || motionSceneId.length === 0) return undefined;
  const selection = composition.tracks
    .flatMap((track) => track.clips.map((clip) => ({ clip, track })))
    .find((item) => item.clip.id === selectedClipId);
  if (selection === undefined) return undefined;

  const suffix =
    motionSceneId
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .split('.')
      .pop() || 'motion';
  const objectId = `motion-scene-${suffix}-${nowMs.toString(36)}`;
  const clipId = `clip-${objectId}`;
  const startUs = selection.clip.startUs;
  const durationUs = selection.clip.durationUs;
  const sceneCount = Object.values(visualProject.visualObjects).filter(
    (item) => item.kind === 'motion-scene',
  ).length;

  const overlaps = (
    track: TimelineComposition['tracks'][number],
    spanStart: number,
    spanDuration: number,
  ): boolean => {
    const spanEnd = spanStart + spanDuration;
    return track.clips.some((clip) => {
      const clipEnd = clip.startUs + clip.durationUs;
      return spanStart < clipEnd && spanEnd > clip.startUs;
    });
  };

  const targetExisting = composition.tracks
    .filter(
      (track) =>
        track.kind === 'video' &&
        track.enabled &&
        track.order > selection.track.order &&
        !overlaps(track, startUs, durationUs),
    )
    .sort((a, b) => a.order - b.order)[0];
  const order = composition.tracks.reduce((max, track) => Math.max(max, track.order), -1) + 1;
  const targetTrackId = targetExisting?.id ?? allocateTimelineTrackId(composition, 'video');
  const insertClipCommand = {
    type: 'timeline.insertClip' as const,
    payload: {
      compositionId: composition.id,
      trackId: targetTrackId,
      clip: {
        id: clipId,
        kind: 'video' as const,
        assetId: `motion-scene:${motionSceneId}`,
        startUs,
        durationUs,
        sourceInUs: 0,
      },
    },
  };
  const timelineCommands =
    targetExisting === undefined
      ? [
          {
            type: 'timeline.addTrack' as const,
            payload: {
              compositionId: composition.id,
              track: {
                id: targetTrackId,
                kind: 'video' as const,
                order,
                enabled: true,
                clips: [],
              },
            },
          },
          insertClipCommand,
        ]
      : [insertClipCommand];

  const object: VisualObjectV1 = {
    id: objectId,
    kind: 'motion-scene',
    motionSceneId,
    transform: {
      x: 80 + sceneCount * 40,
      y: 120,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    },
  };

  return {
    objectId,
    clipId,
    visualTransaction: {
      label: `Add Motion scene ${motionSceneId}`,
      commands: [{ type: 'motionScene.create', payload: { object } }],
    },
    timelineTransaction: {
      label: `Place Motion scene ${motionSceneId}`,
      commands: timelineCommands,
    },
  };
}
