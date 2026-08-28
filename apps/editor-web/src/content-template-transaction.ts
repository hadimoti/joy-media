/** Atomic content-template placement through the universal Timeline service. */
import type { SpikeCommand } from '@joy-media/commands';
import type { Clip, VisualObjectV1 } from '@joy-media/project-schema';
import type { EditorSession } from './editor-session.js';
import type { SeededContentTemplate } from './content-template-types.js';
import { buildTimelineElementDocument } from './place-timeline-element.js';
import { nextProfessionalTrackId } from './timeline-track-family.js';

export function buildContentTemplateTransaction(
  seeded: SeededContentTemplate,
  deps: {
    readonly session: EditorSession;
    readonly selectedClipIds: readonly string[];
    readonly playheadUs: number;
  },
): void {
  const composition = deps.session.timelineProject.compositions.root;
  if (composition === undefined) return;

  const timelineCommands: SpikeCommand[] = [];
  const usedTrackIds = new Set<string>();
  let nextTrackOrder =
    composition.tracks.reduce((maximum, track) => Math.max(maximum, track.order), -1) + 1;
  let document = deps.session.visualProject;

  const overlaps = (
    track: (typeof composition.tracks)[number],
    spanStart: number,
    spanDuration: number,
  ): boolean => {
    const spanEnd = spanStart + spanDuration;
    return track.clips.some((clip) => {
      const clipEnd = clip.startUs + clip.durationUs;
      return spanStart < clipEnd && spanEnd > clip.startUs;
    });
  };

  seeded.template.actions.forEach((action, index) => {
    if (action.kind !== 'html-scene') return;
    const objectId = `${seeded.template.id}-${index}-${seeded.seed}`;
    const clipId = `clip-${objectId}`;
    const startUs = deps.playheadUs;
    const durationUs = 5_000_000;
    const targetExisting = composition.tracks
      .filter(
        (track) =>
          track.family !== 'audio' &&
          track.enabled &&
          !overlaps(track, startUs, durationUs) &&
          !usedTrackIds.has(track.id),
      )
      .sort((left, right) => left.order - right.order)[0];
    const trackId = targetExisting?.id ?? nextProfessionalTrackId(composition.tracks, 'visual');
    if (targetExisting === undefined) {
      timelineCommands.push({
        type: 'timeline.addTrack',
        payload: {
          compositionId: composition.id,
          track: {
            id: trackId,
            kind: 'video',
            family: 'visual',
            name: `Layer ${nextTrackOrder + 1}`,
            order: nextTrackOrder,
            enabled: true,
            clips: [],
          },
        },
      });
      nextTrackOrder += 1;
    }
    usedTrackIds.add(trackId);

    const clip: Clip = {
      id: clipId,
      kind: 'video',
      assetId: `html-scene:${action.sceneId}`,
      startUs,
      durationUs,
      sourceInUs: 0,
    };
    const object: VisualObjectV1 = {
      id: objectId,
      kind: 'html-scene',
      scenePackageId: action.sceneId,
      transform: {
        x: 160 + index * 40,
        y: 120,
        scaleX: 1,
        scaleY: 1,
        rotationDeg: 0,
        opacity: 1,
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
      },
    };
    document = buildTimelineElementDocument({
      baseProject: document,
      clipId,
      planned: { compositionId: composition.id, trackId, clip },
      elementKind: 'html-scene',
      source: { kind: 'object', id: objectId },
      visualObject: object,
    });
    timelineCommands.push({
      type: 'timeline.insertClip',
      payload: { compositionId: composition.id, trackId, clip },
    });
  });

  if (timelineCommands.length === 0) return;
  const label = `Apply template ${seeded.template.label}`;
  deps.session.dispatchCompound(label, {
    document: { ...document, updatedAt: new Date().toISOString() },
    timeline: { label, commands: timelineCommands },
  });
}
