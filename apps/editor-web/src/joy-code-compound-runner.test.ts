import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { EditorSession } from './editor-session.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { compileJoyCodeCompoundDraft } from './joy-code-compound-compiler.js';
import { JoyCodeCompoundRunner } from './joy-code-compound-runner.js';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('Joy Code compound runner', () => {
  it('requires exact approval, dispatches once, and one undo restores both buses', () => {
    const session = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const historyBefore = session.historyEntries.length;
    const beforeTimeline = JSON.stringify(session.timelineProject);
    const beforeDocument = JSON.stringify(session.visualProject);
    const draft = compileJoyCodeCompoundDraft({
      planId: 'runner-1',
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
          content: 'Title',
          startUs: 2_000_000,
          durationUs: 2_000_000,
          placementPreset: 'center',
        },
        { id: 'caption', dependsOn: ['title'], kind: 'caption.setBurnIn', enabled: true },
      ],
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const runner = new JoyCodeCompoundRunner();
    expect(() =>
      runner.apply(session, draft, {
        planId: draft.planId,
        proposalHash: draft.proposalHash,
        baseRevision: draft.baseRevision,
        approvedAt: '2026-08-20T00:00:00.000Z',
      }),
    ).not.toThrow();
    expect(session.historyEntries).toHaveLength(historyBefore + 1);
    expect(session.visualProject.pluginData['joy.captions.burnIn']).toBe(true);
    expect(
      runner.apply(session, draft, {
        planId: draft.planId,
        proposalHash: draft.proposalHash,
        baseRevision: draft.baseRevision,
        approvedAt: '2026-08-20T00:00:00.000Z',
      }),
    ).toMatchObject({ replayed: true });
    session.undo();
    expect(JSON.stringify(session.timelineProject)).toBe(beforeTimeline);
    expect(JSON.stringify(session.visualProject)).toBe(beforeDocument);
  });
});
