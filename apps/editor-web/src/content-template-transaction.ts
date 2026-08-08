/**
 * Content template transaction builder (ADR-0027a).
 *
 * Mirrors `addHtmlSceneToSelectedClip` (App.tsx:1162-1273) but generates
 * deterministic IDs from seed, requires no selection, and batches all
 * commands into single dispatch calls per domain.
 */
import { bindClipToObject } from './sticker-bindings.js';
import type { EditorSession } from './editor-session.js';
import type { SeededContentTemplate } from './content-template-types.js';
import type { SpikeCommand } from '@joy-media/commands';

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

  const voCommands: Array<{
    type: 'htmlScene.create';
    payload: {
      object: {
        id: string;
        kind: 'html-scene';
        scenePackageId: string;
        transform: {
          x: number;
          y: number;
          scaleX: number;
          scaleY: number;
          rotationDeg: number;
          opacity: number;
          crop: { left: number; top: number; right: number; bottom: number };
        };
      };
    };
  }> = [];
  const tlCommands: SpikeCommand[] = [];
  const bindings: Array<[string, string]> = [];

  const { actions } = seeded.template;
  const usedTrackIds = new Set<string>();

  actions.forEach((action, index) => {
    if (action.kind !== 'html-scene') return;

    const sceneId = action.sceneId;
    const objectId = `${seeded.template.id}-${index}-${seeded.seed}`;
    const clipId = `clip-${objectId}`;
    const startUs = deps.playheadUs;
    const durationUs = 5_000_000;

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

    const aboveTracks = composition.tracks
      .filter(
        (track) =>
          track.kind === 'video' &&
          track.enabled &&
          !overlaps(track, startUs, durationUs) &&
          !usedTrackIds.has(track.id),
      )
      .sort((a, b) => a.order - b.order);

    const targetExisting = aboveTracks[0];
    let trackId: string;

    if (targetExisting !== undefined) {
      trackId = targetExisting.id;
    } else {
      const order = composition.tracks.reduce((max, track) => Math.max(max, track.order), -1) + 1;
      trackId = `V${order + 1}`;
      tlCommands.push({
        type: 'timeline.addTrack',
        payload: {
          compositionId: composition.id,
          track: { id: trackId, kind: 'video', order, enabled: true, clips: [] },
        },
      });
    }

    usedTrackIds.add(trackId);

    voCommands.push({
      type: 'htmlScene.create',
      payload: {
        object: {
          id: objectId,
          kind: 'html-scene',
          scenePackageId: sceneId,
          transform: {
            x: 160 + index * 40,
            y: 120,
            scaleX: 1,
            scaleY: 1,
            rotationDeg: 0,
            opacity: 1,
            crop: { left: 0, top: 0, right: 0, bottom: 0 },
          },
        },
      },
    });

    tlCommands.push({
      type: 'timeline.insertClip',
      payload: {
        compositionId: composition.id,
        trackId,
        clip: {
          id: clipId,
          kind: 'video',
          assetId: `html-scene:${sceneId}`,
          startUs,
          durationUs,
          sourceInUs: 0,
        },
      },
    });

    bindings.push([clipId, objectId]);
  });

  if (voCommands.length === 0) return;

  deps.session.dispatchVisualObjects({
    label: `Apply template ${seeded.template.label}`,
    commands: voCommands,
  });
  deps.session.dispatchTimeline({
    label: `Apply template ${seeded.template.label}`,
    commands: tlCommands,
  });
  let project = deps.session.visualProject;
  for (const [clipId, objectId] of bindings) {
    project = bindClipToObject(project, clipId, objectId);
  }
  deps.session.replaceVisualProject(project);
}
