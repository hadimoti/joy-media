import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { DUAL_LENS_FLAG_KEY } from '@joy-media/project-schema';
import type { CreativeArtifactV2, WorkflowNodeV2 } from '@joy-media/project-schema';
import type { ArtifactTransaction, GraphTransaction } from '@joy-media/commands';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession } from './editor-session.js';

function memoryStorage(seed: Readonly<Record<string, string>> = {}) {
  const values = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function enabledStorage() {
  return memoryStorage({ [DUAL_LENS_FLAG_KEY]: 'on' });
}

function graphNode(id: string): WorkflowNodeV2 {
  return {
    id,
    type: 'analysis.transcribe',
    schemaVersion: 1,
    label: id,
    inputs: [{ id: 'in', label: 'Audio', dataType: 'AudioArtifact', required: true }],
    outputs: [{ id: 'out', label: 'Transcript', dataType: 'Transcript', required: true }],
    config: {},
    executionPolicy: { requiredCapabilities: ['timeline.read'], requiresApproval: false },
  };
}

function createArtifact(id: string): CreativeArtifactV2 {
  return {
    id,
    kind: 'changeSet',
    schemaVersion: 1,
    revision: 0,
    label: 'Four-domain approved edit',
    contentRef: { type: 'inline', value: '{}' },
    binding: { type: 'none' },
    provenance: {
      sourceArtifactIds: [],
      inputHashes: [],
      createdBy: { type: 'agent', id: 'joy-code' },
    },
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  };
}

const TRIM_INTRO = {
  label: 'Trim intro',
  commands: [
    {
      type: 'timeline.trimClipEnd' as const,
      payload: {
        compositionId: 'root',
        trackId: 'track-0',
        clipId: 'intro',
        newEndUs: 8_000_000,
      },
    },
  ],
};

function createGraphTransaction(id: string): GraphTransaction {
  return {
    label: `Add ${id}`,
    commands: [{ type: 'graph.node.create', payload: { node: graphNode(id) } }],
  };
}

function createArtifactTransaction(id: string): ArtifactTransaction {
  return {
    label: `Record ${id}`,
    commands: [{ type: 'artifact.create', payload: { artifact: createArtifact(id) } }],
  };
}

describe('EditorSession four-domain compounds', () => {
  it('commits and reverses timeline, document, graph, and artifact changes as one receipt-backed action', () => {
    const storage = enabledStorage();
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const initialTimeline = session.timelineProject;
    const initialDocument = session.visualProject;
    const baseRevision = session.projectRevisionId;

    const receipt = session.commitAgentCompound(
      'Joy Code four-domain edit',
      {
        timeline: TRIM_INTRO,
        document: { ...initialDocument, title: 'Four-domain edit' },
        graph: createGraphTransaction('analysis-1'),
        artifacts: createArtifactTransaction('receipt-artifact-1'),
      },
      {
        executionId: 'four-domain-execution',
        operationDigest: 'a'.repeat(64),
        baseRevision,
        changedEntityIds: ['intro', 'root', 'analysis-1', 'receipt-artifact-1'],
      },
    );

    expect(session.timelineProject).not.toEqual(initialTimeline);
    expect(session.visualProject.title).toBe('Four-domain edit');
    expect(session.workflowGraph.nodes.map((node) => node.id)).toEqual(['analysis-1']);
    expect(session.artifacts.artifacts['receipt-artifact-1']).toBeDefined();
    expect(
      session.historyEntries.filter((entry) => entry.label === 'Joy Code four-domain edit'),
    ).toHaveLength(1);
    expect(receipt.resultRevision).toBe(session.projectRevisionId);
    expect(session.agentIdempotency.getExecutionReceipt(receipt.executionId)).toEqual(receipt);

    session.undo();

    expect(session.timelineProject).toEqual(initialTimeline);
    expect(session.visualProject).toEqual(initialDocument);
    expect(session.workflowGraph.nodes).toEqual([]);
    expect(session.artifacts.artifacts).toEqual({});

    session.redo();

    expect(session.visualProject.title).toBe('Four-domain edit');
    expect(session.workflowGraph.nodes.map((node) => node.id)).toEqual(['analysis-1']);
    expect(session.artifacts.artifacts['receipt-artifact-1']).toBeDefined();
  });

  it('does not permit a graph or artifact participant while Dual Lens persistence is disabled', () => {
    const session = new EditorSession(
      memoryStorage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );

    expect(() =>
      session.dispatchCompound('Unsafe graph', {
        graph: createGraphTransaction('blocked-graph'),
      }),
    ).toThrow(/graph.*disabled/i);
    expect(() =>
      session.dispatchCompound('Unsafe artifact', {
        artifacts: createArtifactTransaction('blocked-artifact'),
      }),
    ).toThrow(/artifact.*disabled/i);
  });

  it('prevalidates a replacement document before it writes an earlier compound participant', () => {
    const values = new Map<string, string>([[DUAL_LENS_FLAG_KEY, 'on']]);
    let writes = 0;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        values.set(key, value);
      },
      removeItem: (key: string) => values.delete(key),
    };
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const writesBefore = writes;
    const timelineBefore = session.timelineProject;

    expect(() =>
      session.dispatchCompound('Invalid document must not start a write', {
        timeline: TRIM_INTRO,
        document: { ...session.visualProject, title: '' },
        graph: createGraphTransaction('not-written'),
        artifacts: createArtifactTransaction('not-written'),
      }),
    ).toThrow(expect.objectContaining({ code: 'PERSISTENCE_COMPOUND_DOCUMENT_INVALID' }));

    expect(writes).toBe(writesBefore);
    expect(session.timelineProject).toEqual(timelineBefore);
    expect(session.workflowGraph.nodes).toEqual([]);
    expect(session.artifacts.artifacts).toEqual({});
  });

  it.each([
    'journal-prepare',
    'timeline',
    'document',
    'graph',
    'artifact',
    'receipt',
    'journal-commit',
  ] as const)(
    'rolls every four-domain failure point back to the complete old state (%s)',
    (failurePoint) => {
      const values = new Map<string, string>([[DUAL_LENS_FLAG_KEY, 'on']]);
      const initialTimeline = buildReferenceSpikeProject();
      const journalKey = `joy-media.editor-compound-write.v1:${encodeURIComponent(initialTimeline.id)}`;
      let armed = false;
      let injected = false;
      let journalWrites = 0;
      const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          const isJournal = key === journalKey;
          if (armed && isJournal) journalWrites += 1;
          const shouldFail =
            armed &&
            !injected &&
            ((failurePoint === 'journal-prepare' && isJournal && journalWrites === 1) ||
              (failurePoint === 'timeline' && key === 'joy-media.timeline-project-log.v1') ||
              (failurePoint === 'document' && key === 'joy-media.visual-object-project-log.v1') ||
              (failurePoint === 'graph' && key === 'joy-media.workflow-graph-log.v1') ||
              (failurePoint === 'artifact' && key === 'joy-media.creative-artifact-log.v1') ||
              (failurePoint === 'receipt' && key.includes('agent-idempotency')) ||
              (failurePoint === 'journal-commit' && isJournal && journalWrites === 2));
          if (shouldFail) {
            injected = true;
            throw new Error(`injected ${failurePoint} persistence failure`);
          }
          values.set(key, value);
        },
        removeItem: (key: string) => values.delete(key),
      };
      const session = new EditorSession(storage, initialTimeline, INITIAL_EDITOR_PROJECT);
      const beforeTimeline = session.timelineProject;
      const beforeDocument = session.visualProject;
      const baseRevision = session.projectRevisionId;

      armed = true;
      expect(() =>
        session.commitAgentCompound(
          `Failure matrix ${failurePoint}`,
          {
            timeline: TRIM_INTRO,
            document: { ...beforeDocument, title: `Failure ${failurePoint}` },
            graph: createGraphTransaction(`failure-${failurePoint}`),
            artifacts: createArtifactTransaction(`failure-${failurePoint}`),
          },
          {
            executionId: `failure-matrix-${failurePoint}`,
            operationDigest: 'b'.repeat(64),
            baseRevision,
            changedEntityIds: ['intro'],
          },
        ),
      ).toThrow(`injected ${failurePoint} persistence failure`);
      expect(injected).toBe(true);
      expect(session.timelineProject).toEqual(beforeTimeline);
      expect(session.visualProject).toEqual(beforeDocument);
      expect(session.workflowGraph.nodes).toEqual([]);
      expect(session.artifacts.artifacts).toEqual({});
      expect(
        session.agentIdempotency.getExecutionReceipt(`failure-matrix-${failurePoint}`),
      ).toBeUndefined();

      const reopened = new EditorSession(storage, initialTimeline, INITIAL_EDITOR_PROJECT);
      expect(reopened.timelineProject).toEqual(beforeTimeline);
      expect(reopened.visualProject).toEqual(beforeDocument);
      expect(reopened.workflowGraph.nodes).toEqual([]);
      expect(reopened.artifacts.artifacts).toEqual({});
      expect(
        reopened.agentIdempotency.getExecutionReceipt(`failure-matrix-${failurePoint}`),
      ).toBeUndefined();
    },
  );
});
