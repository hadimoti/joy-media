import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { DUAL_LENS_FLAG_KEY } from '@joy-media/project-schema';
import type { CreativeArtifactV2 } from '@joy-media/project-schema';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession } from './editor-session.js';
import { planProjectDocumentHydration } from './project-document-hydration.js';

function memoryStorage() {
  const values = new Map<string, string>();
  let failKey: string | undefined;
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (key === failKey) {
        failKey = undefined;
        throw new Error(`injected write failure for ${key}`);
      }
      values.set(key, value);
    },
    failNextWrite: (key: string) => {
      failKey = key;
    },
  };
}

function artifact(id: string): CreativeArtifactV2 {
  return {
    id,
    kind: 'script',
    schemaVersion: 1,
    revision: 0,
    label: id,
    contentRef: { type: 'inline', value: 'content' },
    binding: { type: 'none' },
    provenance: {
      sourceArtifactIds: [],
      inputHashes: [],
      createdBy: { type: 'human', id: 'test' },
    },
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
  };
}

describe('EditorSession', () => {
  it('hydrates all V2 slices as one opening baseline before later saves', () => {
    const storage = memoryStorage();
    storage.setItem(DUAL_LENS_FLAG_KEY, 'on');
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const audio = {
      clips: {},
      buses: [
        { id: 'master', name: 'Master', gain: 0.7, pan: 0, mute: false, solo: false, inputs: [] },
      ],
      effects: [],
    };
    const result = planProjectDocumentHydration(
      {
        schemaVersion: 2,
        projectId: INITIAL_EDITOR_PROJECT.id,
        title: 'Recovered project',
        project: INITIAL_EDITOR_PROJECT,
        timeline: { ...buildReferenceSpikeProject(), id: INITIAL_EDITOR_PROJECT.id },
        workflow: {
          schemaVersion: 1,
          nodes: [
            {
              id: 'recovered-node',
              type: 'analysis.transcribe',
              schemaVersion: 1,
              label: 'Recovered node',
              inputs: [],
              outputs: [],
              config: {},
              executionPolicy: { requiredCapabilities: ['timeline.read'], requiresApproval: false },
            },
          ],
          edges: [],
        },
        artifacts: { artifacts: { recovered: artifact('recovered') }, versions: {} },
        audio,
      },
      INITIAL_EDITOR_PROJECT.id,
      { graphEnabled: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    session.hydrateProjectDocument(result.plan, 'Project hydrated from local V2');
    expect(session.visualProject.title).toBe('Recovered project');
    expect(session.timelineProject.id).toBe(INITIAL_EDITOR_PROJECT.id);
    expect(session.workflowGraph.nodes.map((node) => node.id)).toEqual(['recovered-node']);
    expect(Object.keys(session.artifacts.artifacts)).toEqual(['recovered']);
    expect(session.visualProject.audio).toEqual(audio);
  });

  it('clears stale graph and artifacts when omitted by an enabled V2 document', () => {
    const storage = memoryStorage();
    storage.setItem(DUAL_LENS_FLAG_KEY, 'on');
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    session.dispatchGraph({
      label: 'Seed graph',
      commands: [
        {
          type: 'graph.node.create',
          payload: {
            node: {
              id: 'stale-node',
              type: 'analysis.transcribe',
              schemaVersion: 1,
              label: 'Stale node',
              inputs: [],
              outputs: [],
              config: {},
              executionPolicy: { requiredCapabilities: ['timeline.read'], requiresApproval: false },
            },
          },
        },
      ],
    });
    session.dispatchArtifacts({
      label: 'Seed artifact',
      commands: [{ type: 'artifact.create', payload: { artifact: artifact('stale') } }],
    });
    const result = planProjectDocumentHydration(
      {
        schemaVersion: 2,
        projectId: INITIAL_EDITOR_PROJECT.id,
        project: INITIAL_EDITOR_PROJECT,
        timeline: { ...buildReferenceSpikeProject(), id: INITIAL_EDITOR_PROJECT.id },
      },
      INITIAL_EDITOR_PROJECT.id,
      { graphEnabled: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    session.hydrateProjectDocument(result.plan);
    expect(session.workflowGraph.nodes).toEqual([]);
    expect(session.workflowGraph.edges).toEqual([]);
    expect(session.artifacts).toEqual({ artifacts: {}, versions: {} });
  });

  it('emits one normalized durable notification per mutation and none for no-op history calls', () => {
    const session = new EditorSession(
      memoryStorage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const changes: { label: string; operationCount: number }[] = [];
    session.subscribeDurableChanges((change) => changes.push(change));

    session.dispatchTimeline({
      label: 'Trim intro',
      commands: [
        {
          type: 'timeline.trimClipEnd',
          payload: {
            compositionId: 'root',
            trackId: 'track-0',
            clipId: 'intro',
            newEndUs: 9_000_000,
          },
        },
      ],
    });
    session.dispatchVisualObjects({
      label: 'Move title',
      commands: [
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'intro-title', key: 'x', value: 20 },
        },
      ],
    });
    session.undo();
    session.redo();
    session.jumpToHistory(0);

    expect(changes).toHaveLength(5);
    expect(changes.every((change) => change.operationCount > 0)).toBe(true);
    expect(changes.map((change) => change.label)).toEqual([
      'Trim intro',
      'Move title',
      'Undo Move title',
      'Redo Move title',
      'Jump to history 0',
    ]);
  });

  it('recovers the same durable project revision and advances it for either document slice', () => {
    const storage = memoryStorage();
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const initialRevision = session.projectRevisionId;

    session.dispatchTimeline({
      label: 'Trim intro',
      commands: [
        {
          type: 'timeline.trimClipEnd',
          payload: {
            compositionId: 'root',
            trackId: 'track-0',
            clipId: 'intro',
            newEndUs: 9_000_000,
          },
        },
      ],
    });
    const timelineRevision = session.projectRevisionId;
    expect(timelineRevision).not.toBe(initialRevision);

    session.dispatchVisualObjects({
      label: 'Move title',
      commands: [
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'intro-title', key: 'x', value: 40 },
        },
      ],
    });
    const completeDocumentRevision = session.projectRevisionId;
    expect(completeDocumentRevision).not.toBe(timelineRevision);

    const reopened = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    expect(reopened.projectRevisionId).toBe(completeDocumentRevision);
  });

  it('persists timeline and inspector commands, including undo and redo', () => {
    const storage = memoryStorage();
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    session.dispatchTimeline({
      label: 'Split product',
      commands: [
        {
          type: 'timeline.splitClip',
          payload: {
            compositionId: 'root',
            trackId: 'track-0',
            clipId: 'product',
            atUs: 15_000_000,
            newClipId: 'product-b',
          },
        },
      ],
    });
    session.dispatchVisualObjects({
      label: 'Move title',
      commands: [
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'intro-title', key: 'x', value: 120 },
        },
      ],
    });
    session.undo();
    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(0);
    session.redo();
    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(120);

    const reopened = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    expect(reopened.timelineProject.compositions.root?.tracks[0]?.clips).toHaveLength(4);
    expect(reopened.visualProject.visualObjects['intro-title']?.transform.x).toBe(120);
  });

  it('jumps to a history restore point like a Photoshop history panel', () => {
    const session = new EditorSession(
      memoryStorage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    session.dispatchVisualObjects({
      label: 'Move title',
      commands: [
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'intro-title', key: 'x', value: 50 },
        },
      ],
    });
    session.dispatchVisualObjects({
      label: 'Move title again',
      commands: [
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'intro-title', key: 'x', value: 90 },
        },
      ],
    });
    const entries = session.historyEntries;
    expect(entries.map((e) => e.label)).toEqual(['Document', 'Move title', 'Move title again']);
    expect(entries.at(-1)?.direction).toBe('current');

    session.jumpToHistory(entries[1]!.sequence);
    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(50);
    expect(session.historyCursorSequence).toBe(entries[1]!.sequence);
    expect(session.historyEntries.find((e) => e.direction === 'current')?.label).toBe('Move title');

    session.jumpToHistory(0);
    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(0);

    session.jumpToHistory(entries[2]!.sequence);
    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(90);
  });

  it('records a compound template apply as one undo step and restores both buses', () => {
    const session = new EditorSession(
      memoryStorage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const beforeEntries = session.historyEntries.length;
    const nextDocument = {
      ...session.visualProject,
      visualObjects: {
        ...session.visualProject.visualObjects,
        'intro-title': {
          ...session.visualProject.visualObjects['intro-title']!,
          transform: {
            ...session.visualProject.visualObjects['intro-title']!.transform,
            x: 321,
          },
        },
      },
    };

    session.dispatchCompound('Apply saved title', {
      document: nextDocument,
      timeline: {
        label: 'Apply saved title',
        commands: [
          {
            type: 'timeline.trimClipEnd',
            payload: {
              compositionId: 'root',
              trackId: 'track-0',
              clipId: 'intro',
              newEndUs: 9_000_000,
            },
          },
        ],
      },
    });

    expect(session.historyEntries).toHaveLength(beforeEntries + 1);
    expect(session.historyEntries.at(-1)?.source).toBe('compound');
    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(321);
    expect(session.timelineProject.compositions.root?.tracks[0]?.clips[0]?.durationUs).toBe(
      9_000_000,
    );

    session.undo();
    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(0);
    expect(session.timelineProject.compositions.root?.tracks[0]?.clips[0]?.durationUs).toBe(
      10_000_000,
    );

    session.redo();
    expect(session.visualProject.visualObjects['intro-title']?.transform.x).toBe(321);
    expect(session.timelineProject.compositions.root?.tracks[0]?.clips[0]?.durationUs).toBe(
      9_000_000,
    );
  });

  it('validates every part before writing a compound transaction', () => {
    const session = new EditorSession(
      memoryStorage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const beforeDocument = session.visualProject;
    const beforeEntries = session.historyEntries.length;
    const nextDocument = {
      ...beforeDocument,
      title: 'must not commit',
    };

    expect(() =>
      session.dispatchCompound('Invalid template apply', {
        document: nextDocument,
        timeline: {
          label: 'Invalid template apply',
          commands: [
            {
              type: 'timeline.trimClipEnd',
              payload: {
                compositionId: 'root',
                trackId: 'track-0',
                clipId: 'missing-clip',
                newEndUs: 1,
              },
            },
          ],
        },
      }),
    ).toThrow();
    expect(session.visualProject).toBe(beforeDocument);
    expect(session.historyEntries).toHaveLength(beforeEntries);
  });

  it('leaves both durable buses unchanged when a compound snapshot write fails', () => {
    const storage = memoryStorage();
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const beforeDocument = session.visualProject;
    const beforeTimeline = session.timelineProject;
    const beforeEntries = session.historyEntries.length;
    const nextDocument = {
      ...beforeDocument,
      title: 'must roll back',
    };
    storage.failNextWrite('joy-media.visual-object-project-log.v1');

    expect(() =>
      session.dispatchCompound('Injected failure', {
        document: nextDocument,
        timeline: {
          label: 'Injected failure',
          commands: [
            {
              type: 'timeline.trimClipEnd',
              payload: {
                compositionId: 'root',
                trackId: 'track-0',
                clipId: 'intro',
                newEndUs: 9_000_000,
              },
            },
          ],
        },
      }),
    ).toThrow('injected write failure');

    expect(session.visualProject).toBe(beforeDocument);
    expect(session.timelineProject).toBe(beforeTimeline);
    expect(session.historyEntries).toHaveLength(beforeEntries);

    const reopened = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    expect(reopened.visualProject).toEqual(beforeDocument);
    expect(reopened.timelineProject).toEqual(beforeTimeline);
  });
});
