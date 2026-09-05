import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { EditorSession } from '../editor-session.js';
import { createAgentPreviewStore } from '../agent-preview-store.js';
import { compileJoyCodeCompoundDraft } from '../joy-code-compound-compiler.js';
import { stageJoyAgentPreview } from './stage-preview.js';

describe('mounted model preview staging', () => {
  it('retains document-only previews and rejects stale proposals without applying', () => {
    const session = new EditorSession(
      { getItem: () => null, setItem: () => {} },
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const store = createAgentPreviewStore();
    const before = session.visualProject;
    const draft = compileJoyCodeCompoundDraft({
      planId: 'preview',
      baseRevision: session.projectRevisionId,
      timeline: session.timelineProject,
      visualProject: before,
      registeredAssetIds: [],
      operations: [{ id: 'caption', dependsOn: [], kind: 'caption.setBurnIn', enabled: true }],
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.timeline).toBeUndefined();
    stageJoyAgentPreview(store, session, draft);
    expect(store.getState().document?.preview.pluginData['joy.captions.burnIn']).toBe(true);
    expect(store.getState().timeline).toBeUndefined();
    expect(session.visualProject).toBe(before);
    expect(() => stageJoyAgentPreview(store, session, { ...draft, baseRevision: 'stale' })).toThrow(
      'stale',
    );
    expect(store.getState().document).toBeUndefined();
  });

  it('does not infer a document preview from a cloned unchanged document', () => {
    const session = new EditorSession(
      { getItem: () => null, setItem: () => {} },
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const store = createAgentPreviewStore();
    const draft = compileJoyCodeCompoundDraft({
      planId: 'preview-clone',
      baseRevision: session.projectRevisionId,
      timeline: session.timelineProject,
      visualProject: session.visualProject,
      registeredAssetIds: [],
      operations: [{ id: 'caption', dependsOn: [], kind: 'caption.setBurnIn', enabled: true }],
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    stageJoyAgentPreview(store, session, {
      ...draft,
      // PreparedChangeStore intentionally clones the private canonical payload.
      // `documentChanged`, not reference identity, determines preview scope.
      document: JSON.parse(JSON.stringify(session.visualProject)),
      documentChanged: false,
    });

    expect(store.getState().document).toBeUndefined();
    expect(store.getState().timeline).toBeUndefined();
  });
});
