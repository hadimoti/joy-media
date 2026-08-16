import type { CommandTransaction, SpikeCommand } from '@joy-media/commands';
import type { JoyProjectV1, VisualObjectV1 } from '@joy-media/project-schema';
import type { EditorSession } from './editor-session.js';
import { bindClipToObject } from './sticker-bindings.js';
import type { TextTemplateV1 } from './text-template-catalog.js';
import { upsertUniversalTimelineBinding } from './universal-placement.js';

export interface InsertedTextTemplate {
  readonly clipId: string;
  readonly objectId: string;
}

/** Inserts a native text object and its timeline presentation in one compound undo step. */
export function insertTextTemplate(
  session: EditorSession,
  template: TextTemplateV1,
  playheadUs: number,
): InsertedTextTemplate | undefined {
  const timeline = session.timelineProject;
  const composition = timeline.compositions[timeline.rootCompositionId];
  if (composition === undefined) return undefined;

  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const objectId = `text-${template.id}-${suffix}`;
  const clipId = `clip-${objectId}`;
  const startUs = Math.max(
    0,
    Math.min(playheadUs, Math.max(0, composition.durationUs - 5_000_000)),
  );
  const durationUs = Math.min(5_000_000, composition.durationUs - startUs);
  if (durationUs <= 0) return undefined;

  const object: VisualObjectV1 = {
    id: objectId,
    kind: 'text',
    text: template.sample,
    textDocument: template.document,
    textStyle: template.style,
    transform: {
      x: composition.width / 2,
      y: composition.height / 2,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    },
  };

  const overlaps = (track: (typeof composition.tracks)[number]) =>
    track.clips.some(
      (clip) => startUs < clip.startUs + clip.durationUs && startUs + durationUs > clip.startUs,
    );
  const targetTrack = composition.tracks
    .filter((track) => track.kind === 'video' && track.enabled && !overlaps(track))
    .sort((a, b) => a.order - b.order)[0];
  const trackId = targetTrack?.id ?? `text-track-${suffix}`;
  const trackCommands: SpikeCommand[] =
    targetTrack === undefined
      ? [
          {
            type: 'timeline.addTrack',
            payload: {
              compositionId: composition.id,
              track: {
                id: trackId,
                kind: 'video',
                name: 'Text',
                order: composition.tracks.length,
                enabled: true,
                clips: [],
              },
            },
          },
        ]
      : [];
  const insertClip: SpikeCommand = {
    type: 'timeline.insertClip',
    payload: {
      compositionId: composition.id,
      trackId,
      clip: {
        id: clipId,
        kind: 'video',
        assetId: `joy.text:${template.id}`,
        startUs,
        durationUs,
        sourceInUs: 0,
      },
    },
  };
  const timelineTransaction: CommandTransaction = {
    label: `Add text ${template.label}`,
    commands: [...trackCommands, insertClip],
  };
  const withTextObject: JoyProjectV1 = bindClipToObject(
    {
      ...session.visualProject,
      visualObjects: { ...session.visualProject.visualObjects, [objectId]: object },
      compositions: addVisualTextClip(session.visualProject, {
        trackId,
        clipId,
        template,
        startUs,
        durationUs,
      }),
    },
    clipId,
    objectId,
  );
  const nextProject = upsertUniversalTimelineBinding(withTextObject, {
    id: clipId,
    compositionId: composition.id,
    trackId,
    elementKind: 'text',
    startUs,
    durationUs,
    source: { kind: 'object', id: objectId },
  });
  session.dispatchCompound(`Add text ${template.label}`, {
    timeline: timelineTransaction,
    document: nextProject,
  });
  return { clipId, objectId };
}

function addVisualTextClip(
  project: JoyProjectV1,
  input: {
    readonly trackId: string;
    readonly clipId: string;
    readonly template: TextTemplateV1;
    readonly startUs: number;
    readonly durationUs: number;
  },
): JoyProjectV1['compositions'] {
  const compositionId = project.rootCompositionId;
  const composition = project.compositions[compositionId];
  if (composition === undefined) return project.compositions;
  const clip = {
    id: input.clipId,
    kind: 'video' as const,
    assetId: `joy.text:${input.template.id}`,
    startUs: input.startUs,
    durationUs: input.durationUs,
    sourceInUs: 0,
  };
  const existing = composition.tracks.find((track) => track.id === input.trackId);
  const tracks =
    existing === undefined
      ? [
          ...composition.tracks,
          {
            id: input.trackId,
            kind: 'video' as const,
            name: 'Text',
            order: composition.tracks.length,
            enabled: true,
            locked: false,
            clips: [clip],
          },
        ]
      : composition.tracks.map((track) =>
          track.id === input.trackId ? { ...track, clips: [...track.clips, clip] } : track,
        );
  return { ...project.compositions, [compositionId]: { ...composition, tracks } };
}
