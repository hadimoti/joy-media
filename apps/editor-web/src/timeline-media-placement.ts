import type { AudioState, CommandTransaction } from '@joy-media/commands';
import { withProjectAudio } from './audio-session.js';
import type { EditorSession } from './editor-session.js';
import { bindMediaClipToProject, type ImportedMediaAsset } from './media-project.js';
import { prepareTimelinePresentation } from './timeline-presentation.js';

export interface TimelineMediaPlacement {
  readonly asset: Omit<ImportedMediaAsset, 'descriptor'> & {
    readonly descriptor: NonNullable<ImportedMediaAsset['descriptor']>;
  };
  readonly clipId: string;
  /** Frame of the composition the clip was placed in; new media is fitted to it (T-D01). */
  readonly frame?: { readonly width: number; readonly height: number };
}

/** Commits a timeline placement and its media binding as one editor history entry. */
export function applyTimelineMediaPlacement(
  session: EditorSession,
  audio: AudioState,
  transaction: CommandTransaction,
  placements: readonly TimelineMediaPlacement[],
): AudioState {
  const prepared = prepareTimelinePresentation(
    session.visualProject,
    audio,
    session.timelineProject,
    transaction,
  );
  const project = placements.reduce(
    (current, placement) =>
      bindMediaClipToProject(current, placement.asset, placement.clipId, placement.frame),
    prepared.project,
  );
  session.dispatchCompound(transaction.label, {
    timeline: transaction,
    document: withProjectAudio(project, prepared.audio),
  });
  return prepared.audio;
}
