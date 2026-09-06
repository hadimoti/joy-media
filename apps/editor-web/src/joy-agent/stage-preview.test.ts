import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { EditorSession } from '../editor-session.js';
import { createAgentPreviewStore } from '../agent-preview-store.js';
import { compileJoyCodeCompoundDraft } from '../joy-code-compound-compiler.js';
import { stageJoyAgentPreview } from './stage-preview.js';

describe('mounted model preview staging', () => {
  it('computes dual timeline and document previews before one atomic publication', () => {
    const session = new EditorSession(
      { getItem: () => null, setItem: () => {} },
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const store = createAgentPreviewStore();
    const snapshots: ReturnType<typeof store.getState>[] = [];
    store.subscribe(() => snapshots.push(store.getState()));
    const draft = compileJoyCodeCompoundDraft({
      planId: 'preview-dual',
      baseRevision: session.projectRevisionId,
      timeline: session.timelineProject,
      visualProject: session.visualProject,
      registeredAssetIds: [],
      operations: [
        {
          id: 'title',
          dependsOn: [],
          kind: 'text.insertTemplate',
          templateId: 'clean-title',
          content: 'Atomic preview',
          startUs: 0,
          durationUs: 1_000_000,
          placementPreset: 'center',
        },
      ],
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.timeline).toBeDefined();
    expect(draft.documentChanged).toBe(true);

    // Replacing an older stage for the same run must not briefly clear it (or
    // expose just one of the newly computed surfaces) before the new bundle.
    store.publish({
      runId: draft.planId,
      baseRevision: draft.baseRevision,
      document: { canonical: session.visualProject, preview: session.visualProject },
    });
    snapshots.length = 0;

    stageJoyAgentPreview(store, session, draft);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.timeline).toBeDefined();
    expect(snapshots[0]?.document).toBeDefined();
    expect(snapshots[0]?.timeline?.bundleVersion).toBe(snapshots[0]?.document?.bundleVersion);
    expect(store.getBundle()?.timeline).toBe(snapshots[0]?.timeline);
    expect(store.getBundle()?.document).toBe(snapshots[0]?.document);
  });

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
    expect(store.getBundle()).toBeUndefined();
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
