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
  store?.clear(draft.planId);
  if (draft.baseRevision !== session.projectRevisionId)
    throw new Error('The proposal is stale. Request a new preview.');
  // Compute the timeline first so failure cannot leave half a preview staged.
  const timeline =
    draft.timeline === undefined
      ? undefined
      : applyTransaction(session.timelineProject, draft.timeline).project;
  // Prepared changes are intentionally cloned before they reach this surface,
  // so reference identity no longer says whether the visual document changed.
  if (draft.documentChanged)
    store?.setDocument({
      runId: draft.planId,
      baseRevision: draft.baseRevision,
      canonical: session.visualProject,
      preview: draft.document,
    });
  if (timeline !== undefined)
    store?.setTimeline({
      runId: draft.planId,
      baseRevision: draft.baseRevision,
      canonical: previewTimelineFromProject(session.timelineProject),
      preview: previewTimelineFromProject(timeline),
    });
}
