import { applyTransaction } from '@joy-media/commands';
import type { AgentPreviewStore } from '../agent-preview-store.js';
import { previewTimelineFromProject } from '../agent-timeline-preview.js';
import type { EditorSession } from '../editor-session.js';
import type { JoyCodeCompoundDraft } from '../joy-code-compound-compiler.js';

export function stageJoyAgentPreview(
  store: AgentPreviewStore | undefined,
  session: EditorSession,
  draft: JoyCodeCompoundDraft,
): void {
  if (draft.baseRevision !== session.projectRevisionId) {
    // A stale stage must not leave an older preview for this run visible.
    store?.clear(draft.planId);
    throw new Error('The proposal is stale. Request a new preview.');
  }

  try {
    // Build every surface before publishing. A failure clears only this run's
    // prior stage; a success makes exactly one atomic store publication.
    const timeline =
      draft.timeline === undefined
        ? undefined
        : applyTransaction(session.timelineProject, draft.timeline).project;
    const timelinePreview =
      timeline === undefined
        ? undefined
        : {
            canonical: previewTimelineFromProject(session.timelineProject),
            preview: previewTimelineFromProject(timeline),
          };
    // Prepared changes are intentionally cloned before they reach this surface,
    // so reference identity no longer says whether the visual document changed.
    const documentPreview = draft.documentChanged
      ? { canonical: session.visualProject, preview: draft.document }
      : undefined;

    if (timelinePreview === undefined && documentPreview === undefined) {
      store?.clear(draft.planId);
      return;
    }

    store?.publish({
      runId: draft.planId,
      baseRevision: draft.baseRevision,
      ...(timelinePreview === undefined ? {} : { timeline: timelinePreview }),
      ...(documentPreview === undefined ? {} : { document: documentPreview }),
    });
  } catch (error) {
    store?.clear(draft.planId);
    throw error;
  }
}
