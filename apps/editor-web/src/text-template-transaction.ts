import type { CommandTransaction, SpikeCommand } from '@joy-media/commands';
import {
  normalizeUniversalTimeline,
  UNIVERSAL_TIMELINE_SCHEMA_VERSION,
  type JoyProjectV1,
  type SpikeProject,
  type VisualObjectV1,
} from '@joy-media/project-schema';
import type { EditorSession } from './editor-session.js';
import { readClipObjectMap } from './sticker-bindings.js';
import type { TextTemplateV1 } from './text-template-catalog.js';
import { nextProfessionalTrackId } from './timeline-track-family.js';
import { withTimelineElementKinds } from './timeline-element-kind.js';

export interface InsertedTextTemplate {
  readonly clipId: string;
  readonly objectId: string;
}

export interface PreparedTextTemplateInsertion {
  readonly inserted: InsertedTextTemplate;
  readonly timeline: CommandTransaction;
  readonly document: JoyProjectV1;
  readonly label: string;
}

/** Canonical ID derivation shared by preview compilation and output references. */
export function joyCodeInsertedTextObjectId(
  templateId: string,
  planId: string,
  operationIndex: number,
): string {
  return `text-${templateId}-${planId}-${operationIndex}`;
}

/** Pure, deterministic preparation seam used by Joy Code and the manual wrapper. */
export function prepareTextTemplateInsertion(
  timeline: SpikeProject,
  visualProject: JoyProjectV1,
  template: TextTemplateV1,
  playheadUs: number,
  idSuffix: string,
  durationOverrideUs?: number,
  placement: 'center' | 'top' | 'bottom' | 'lower-third' = 'center',
): PreparedTextTemplateInsertion | undefined {
  const composition = timeline.compositions[timeline.rootCompositionId];
  if (composition === undefined || !Number.isFinite(playheadUs)) return undefined;
  const objectId = `text-${template.id}-${idSuffix}`;
  const clipId = `clip-${objectId}`;
  const requestedDurationUs = durationOverrideUs ?? 5_000_000;
  const startUs = Math.max(
    0,
    Math.min(playheadUs, Math.max(0, composition.durationUs - requestedDurationUs)),
  );
  const durationUs = Math.min(requestedDurationUs, composition.durationUs - startUs);
  if (durationUs <= 0) return undefined;
  const object: VisualObjectV1 = {
    id: objectId,
    kind: 'text',
    text: template.sample,
    textDocument: template.document,
    textStyle: template.style,
    transform: {
      x: composition.width / 2,
      y:
        placement === 'top'
          ? composition.height * 0.2
          : placement === 'bottom'
            ? composition.height * 0.8
            : placement === 'lower-third'
              ? composition.height * 0.72
              : composition.height / 2,
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
    .filter(
      (track) =>
        track.kind === 'video' &&
        track.family !== 'audio' &&
        track.enabled &&
        track.locked !== true &&
        !overlaps(track),
    )
    .sort((a, b) => a.order - b.order)[0];
  // Keep text insertion on the same collision-free visual track namespace as
  // every other timeline insertion path. The suffix is an object/clip token,
  // not a stable track identity and must never be used as one.
  const trackId = targetTrack?.id ?? nextProfessionalTrackId(composition.tracks, 'visual');
  const nextTrackOrder =
    composition.tracks.reduce((highest, track) => Math.max(highest, track.order), -1) + 1;
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
                family: 'visual',
                name: 'Text',
                order: nextTrackOrder,
                enabled: true,
                clips: [],
              },
            },
          },
        ]
      : [];
  const clip = {
    id: clipId,
    kind: 'video' as const,
    assetId: `joy.text:${template.id}`,
    startUs,
    durationUs,
    sourceInUs: 0,
  };
  const timelineTransaction: CommandTransaction = {
    label: `Add text ${template.label}`,
    commands: [
      ...trackCommands,
      { type: 'timeline.insertClip', payload: { compositionId: composition.id, trackId, clip } },
    ],
  };
  const visualComposition = visualProject.compositions[visualProject.rootCompositionId];
  if (visualComposition === undefined) return undefined;
  const visualTracks = visualComposition.tracks.some((track) => track.id === trackId)
    ? visualComposition.tracks.map((track) =>
        track.id === trackId ? { ...track, clips: [...track.clips, clip] } : track,
      )
    : [
        ...visualComposition.tracks,
        {
          id: trackId,
          kind: 'video' as const,
          name: 'Text',
          order:
            visualComposition.tracks.reduce(
              (highest, track) => Math.max(highest, track.order),
              -1,
            ) + 1,
          enabled: true,
          locked: false,
          clips: [clip],
        },
      ];
  const map = { ...readClipObjectMap(visualProject), [clipId]: objectId };
  const normalized = normalizeUniversalTimeline(visualProject);
  const existingItems = normalized.document.items.filter((item) => item.id !== clipId);
  const nextOrder =
    existingItems
      .filter((item) => item.compositionId === visualComposition.id && item.trackId === trackId)
      .reduce((highest, item) => Math.max(highest, item.withinTrackOrder), -1) + 1;
  const document = withTimelineElementKinds(
    {
      ...visualProject,
      visualObjects: { ...visualProject.visualObjects, [objectId]: object },
      compositions: {
        ...visualProject.compositions,
        [visualProject.rootCompositionId]: { ...visualComposition, tracks: visualTracks },
      },
      pluginData: { ...visualProject.pluginData, ['joy.clipObjects']: map },
      universalTimeline: {
        schemaVersion: UNIVERSAL_TIMELINE_SCHEMA_VERSION,
        items: [
          ...existingItems,
          {
            id: clipId,
            compositionId: visualComposition.id,
            trackId,
            elementKind: 'text',
            startUs,
            durationUs,
            source: { kind: 'object', id: objectId },
            withinTrackOrder: nextOrder,
          },
        ],
      },
    },
    { [clipId]: 'text' },
  );
  return {
    inserted: { clipId, objectId },
    timeline: timelineTransaction,
    document,
    label: timelineTransaction.label,
  };
}

/** Inserts a native text object and its timeline presentation in one compound undo step. */
export function insertTextTemplate(
  session: EditorSession,
  template: TextTemplateV1,
  playheadUs: number,
): InsertedTextTemplate | undefined {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const prepared = prepareTextTemplateInsertion(
    session.timelineProject,
    session.visualProject,
    template,
    playheadUs,
    suffix,
  );
  if (prepared === undefined) return undefined;
  session.dispatchCompound(prepared.label, {
    timeline: prepared.timeline,
    document: prepared.document,
  });
  return prepared.inserted;
}
