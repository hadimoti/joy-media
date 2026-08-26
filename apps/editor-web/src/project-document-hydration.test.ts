import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import type { ProjectDocumentV2, WorkflowGraphV2 } from '@joy-media/project-schema';
import { EMPTY_AUDIO_STATE } from './audio-session.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession } from './editor-session.js';
import { projectDocumentFromSession, ProjectDocumentSpine } from './project-document-spine.js';
import { planProjectDocumentHydration } from './project-document-hydration.js';

const PROJECT_ID = INITIAL_EDITOR_PROJECT.id;

function document(overrides: Partial<ProjectDocumentV2> = {}): ProjectDocumentV2 {
  return {
    schemaVersion: 2,
    projectId: PROJECT_ID,
    title: 'Recovered title',
    project: INITIAL_EDITOR_PROJECT,
    timeline: { ...buildReferenceSpikeProject(), id: PROJECT_ID },
    ...overrides,
  } as unknown as ProjectDocumentV2;
}

describe('planProjectDocumentHydration', () => {
  it('can be applied before the opening save so the recovered title survives projection', async () => {
    const saves: ProjectDocumentV2[] = [];
    const result = planProjectDocumentHydration(document({ title: 'Local V2 title' }), PROJECT_ID, {
      graphEnabled: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const storage = {
      getItem: () => null,
      setItem: () => undefined,
    };
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    session.hydrateProjectDocument(result.plan, 'Project hydrated from local V2');
    const spine = new ProjectDocumentSpine({
      session,
      journal: { saveSnapshot: async (saved) => void saves.push(saved) },
      coordinator: { queueLocalDocument: () => undefined },
    });
    await spine.saveCurrent({ label: 'Project opened (local V2 recovered)', operationCount: 1 });
    expect(saves[0]?.title).toBe('Local V2 title');
  });

  it('accepts a complete document and preserves audio, graph, and artifacts', () => {
    const workflow: WorkflowGraphV2 = { schemaVersion: 1, nodes: [], edges: [] };
    const audio = {
      clips: { intro: { gain: 0.5, pan: -0.2, mute: false, solo: true } },
      buses: [
        { id: 'master', name: 'Master', gain: 1, pan: 0, mute: false, solo: false, inputs: [] },
      ],
      effects: [],
    };
    const artifacts = { artifacts: {}, versions: {} };
    const result = planProjectDocumentHydration(
      document({ workflow: workflow as never, artifacts, audio }),
      PROJECT_ID,
      {
        graphEnabled: true,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.visualProject.title).toBe('Recovered title');
    expect(result.plan.timelineProject.id).toBe(PROJECT_ID);
    expect(result.plan.workflowGraph).toEqual(workflow);
    expect(result.plan.artifacts).toEqual(artifacts);
    expect(result.plan.audioState).toEqual(audio);
    expect(result.plan.visualProject.audio).toEqual(audio);
  });

  it('treats omitted audio as authoritative and prevents stale sidecar projection', () => {
    const staleAudio = {
      clips: { intro: { gain: 0.1, pan: 0, mute: false, solo: false } },
      buses: [],
      effects: [],
    };
    const result = planProjectDocumentHydration(
      document({ project: { ...INITIAL_EDITOR_PROJECT, audio: staleAudio } as never }),
      PROJECT_ID,
      { graphEnabled: false },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.audioStatePresent).toBe(false);
    expect(result.plan.audioState).toBeUndefined();
    expect(result.plan.visualProject.audio).toBeUndefined();
    const storage = { getItem: () => null, setItem: () => undefined };
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    session.hydrateProjectDocument(result.plan);
    const projected = projectDocumentFromSession(session, EMPTY_AUDIO_STATE as never);
    expect(projected.audio).toEqual(EMPTY_AUDIO_STATE);
    expect(projected.audio).not.toEqual(staleAudio);
  });

  it('rejects malformed V2 without producing a partial plan', () => {
    const result = planProjectDocumentHydration(
      document({ project: { ...INITIAL_EDITOR_PROJECT, visualObjects: null } as never }),
      PROJECT_ID,
      { graphEnabled: true },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('rejects graph data when the opened session has graph editing disabled', () => {
    const result = planProjectDocumentHydration(
      document({ workflow: { schemaVersion: 1, nodes: [], edges: [] } as never }),
      PROJECT_ID,
      { graphEnabled: false },
    );
    expect(result.ok).toBe(false);
  });

  it('rejects arbitrary audio JSON instead of mutating a session with it', () => {
    const result = planProjectDocumentHydration(
      document({ audio: { overwrite: true } }),
      PROJECT_ID,
      {
        graphEnabled: true,
      },
    );
    expect(result.ok).toBe(false);
  });

  it('normalizes a remote envelope id back to the local creative project id', () => {
    const result = planProjectDocumentHydration(
      document({ projectId: 'project-remote-1' }),
      'project-remote-1',
      { graphEnabled: false, sessionProjectId: PROJECT_ID },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.visualProject.id).toBe(PROJECT_ID);
    expect(result.plan.timelineProject.id).toBe(PROJECT_ID);
  });
});
