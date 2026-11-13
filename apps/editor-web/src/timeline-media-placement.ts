import type { AudioState, CommandTransaction } from '@joy-media/commands';
import { withProjectAudio } from './audio-session.js';
import type { EditorSession } from './editor-session.js';
import { bindMediaClipToProject, type ImportedMediaAsset } from './media-project.js';
import { buildDerivedClipPresentation } from './speed-ramp.js';
import { prepareTimelinePresentation } from './timeline-presentation.js';

export interface TimelineMediaPlacement {
  readonly asset: Omit<ImportedMediaAsset, 'descriptor'> & {
    readonly descriptor: NonNullable<ImportedMediaAsset['descriptor']>;
  };
  readonly clipId: string;
  /** Frame of the composition the clip was placed in; new media is fitted to it (T-D01). */
  readonly frame?: { readonly width: number; readonly height: number };
}

/**
 * A new clip that copies another clip's document state (visual-object binding,
 * element kind, property animations, audio mix). Duplicate and paste share this path.
 */
export interface TimelineClipCopy {
  readonly sourceClipId: string;
  readonly clipId: string;
}

/**
 * Commits a timeline placement, its media binding and any clip copies as one editor
 * history entry.
 */
export function applyTimelineMediaPlacement(
  session: EditorSession,
  audio: AudioState,
  transaction: CommandTransaction,
  placements: readonly TimelineMediaPlacement[],
  copies: readonly TimelineClipCopy[] = [],
): AudioState {
  const prepared = prepareTimelinePresentation(
    session.visualProject,
    audio,
    session.timelineProject,
    transaction,
  );
  let nextProject = prepared.project;
  let nextAudio = prepared.audio;
  for (const copy of copies) {
    const derived = buildDerivedClipPresentation(nextProject, nextAudio, copy.sourceClipId, [
      copy.clipId,
    ]);
    nextProject = derived.project;
    nextAudio = derived.audio;
  }
  const project = placements.reduce(
    (current, placement) =>
      bindMediaClipToProject(current, placement.asset, placement.clipId, placement.frame),
    nextProject,
  );
  session.dispatchCompound(transaction.label, {
    timeline: transaction,
    document: withProjectAudio(project, nextAudio),
  });
  return nextAudio;
}
