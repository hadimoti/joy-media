import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { DUAL_LENS_FLAG_KEY } from '@joy-media/project-schema';
import type { WorkflowNodeV2 } from '@joy-media/project-schema';
import type { GraphTransaction } from '@joy-media/commands';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession } from './editor-session.js';

function memoryStorage(seed: Readonly<Record<string, string>> = {}) {
  const values = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    keys: () => [...values.keys()],
  };
}

function enabledStorage() {
  return memoryStorage({ [DUAL_LENS_FLAG_KEY]: 'on' });
}

function openSession(storage: ReturnType<typeof memoryStorage>) {
  return new EditorSession(storage, buildReferenceSpikeProject(), INITIAL_EDITOR_PROJECT);
}

function node(id: string): WorkflowNodeV2 {
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

function addNode(id: string): GraphTransaction {
  return { label: `Add ${id}`, commands: [{ type: 'graph.node.create', payload: { node: node(id) } }] };
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

describe('EditorSession workflow graph', () => {
  describe('the flag gates the document, not just the view', () => {
    it('refuses graph edits when disabled', () => {
      const session = openSession(memoryStorage());

      expect(session.graphEnabled).toBe(false);
      expect(() => session.dispatchGraph(addNode('a'))).toThrow(/disabled/);
    });

    it('opens no graph log when disabled', () => {
      // Off has to mean nothing is stored, not merely nothing is drawn —
      // otherwise turning the feature off leaves a document behind.
      const storage = memoryStorage();
      openSession(storage);

      expect(storage.keys().some((key) => key.includes('workflow-graph'))).toBe(false);
    });

    it('accepts graph edits when enabled', () => {
      const session = openSession(enabledStorage());

      expect(session.graphEnabled).toBe(true);
      expect(session.dispatchGraph(addNode('a')).nodes.map((n) => n.id)).toEqual(['a']);
    });

    it('starts empty', () => {
      expect(openSession(enabledStorage()).workflowGraph.nodes).toEqual([]);
    });
  });

  describe('one unified history across both lenses', () => {
    it('steps back through interleaved timeline and graph edits in the order they were made', () => {
      // The property the whole design turns on: undo follows what the user did,
      // not which lens they were looking through when they did it.
      const session = openSession(enabledStorage());

      session.dispatchGraph(addNode('a'));
      session.dispatchTimeline(TRIM_INTRO);
      session.dispatchGraph(addNode('b'));

      expect(session.workflowGraph.nodes.map((n) => n.id)).toEqual(['a', 'b']);

      session.undo(); // removes b
      expect(session.workflowGraph.nodes.map((n) => n.id)).toEqual(['a']);
      expect(clipEnd(session)).toBe(8_000_000);

      session.undo(); // restores the intro trim, graph untouched
      expect(session.workflowGraph.nodes.map((n) => n.id)).toEqual(['a']);
      expect(clipEnd(session)).toBe(10_000_000);

      session.undo(); // removes a
      expect(session.workflowGraph.nodes).toEqual([]);
    });

    it('redoes in the same interleaved order', () => {
      const session = openSession(enabledStorage());
      session.dispatchGraph(addNode('a'));
      session.dispatchTimeline(TRIM_INTRO);

      session.undo();
      session.undo();
      expect(session.workflowGraph.nodes).toEqual([]);
      expect(clipEnd(session)).toBe(10_000_000);

      session.redo();
      expect(session.workflowGraph.nodes.map((n) => n.id)).toEqual(['a']);
      expect(clipEnd(session)).toBe(10_000_000);

      session.redo();
      expect(clipEnd(session)).toBe(8_000_000);
    });

    it('reverts a multi-command graph transaction in one undo', () => {
      const session = openSession(enabledStorage());

      session.dispatchGraph({
        label: 'Add transcribe branch',
        commands: [
          { type: 'graph.node.create', payload: { node: node('a') } },
          { type: 'graph.node.create', payload: { node: node('b') } },
        ],
      });
      expect(session.workflowGraph.nodes).toHaveLength(2);

      session.undo();

      expect(session.workflowGraph.nodes).toEqual([]);
    });

    it('shows graph edits in the same history strip', () => {
      const session = openSession(enabledStorage());
      session.dispatchGraph(addNode('a'));

      const entry = session.historyEntries.find((e) => e.label === 'Add a');

      expect(entry?.source).toBe('graph');
      expect(entry?.commandCount).toBe(1);
    });

    it('jumps to a restore point across both lenses', () => {
      const session = openSession(enabledStorage());
      session.dispatchGraph(addNode('a'));
      const afterGraph = session.historyCursorSequence;
      session.dispatchTimeline(TRIM_INTRO);

      session.jumpToHistory(afterGraph);

      expect(session.workflowGraph.nodes.map((n) => n.id)).toEqual(['a']);
      expect(clipEnd(session)).toBe(10_000_000);
    });
  });

  describe('revision and durability', () => {
    it('advances the project revision, so a plan built before a graph edit is stale', () => {
      const session = openSession(enabledStorage());
      const before = session.projectRevisionId;

      session.dispatchGraph(addNode('a'));

      expect(session.projectRevisionId).not.toBe(before);
    });

    it('recovers the graph and its revision after reopening', () => {
      const storage = enabledStorage();
      const first = openSession(storage);
      first.dispatchGraph(addNode('a'));
      const revision = first.projectRevisionId;

      const reopened = openSession(storage);

      expect(reopened.workflowGraph.nodes.map((n) => n.id)).toEqual(['a']);
      expect(reopened.projectRevisionId).toBe(revision);
    });

    it('leaves the graph untouched when a transaction is rejected', () => {
      const session = openSession(enabledStorage());
      session.dispatchGraph(addNode('a'));
      const revision = session.projectRevisionId;

      expect(() =>
        session.dispatchGraph({
          label: 'Duplicate',
          commands: [{ type: 'graph.node.create', payload: { node: node('a') } }],
        }),
      ).toThrow();

      expect(session.workflowGraph.nodes.map((n) => n.id)).toEqual(['a']);
      expect(session.projectRevisionId).toBe(revision);
      // A rejected edit must not leave an entry that undoes nothing.
      expect(session.historyEntries.filter((e) => e.label === 'Duplicate')).toEqual([]);
    });
  });
});

function clipEnd(session: EditorSession): number {
  const clip = session.timelineProject.compositions['root']?.tracks
    .find((track) => track.id === 'track-0')
    ?.clips.find((candidate) => candidate.id === 'intro');
  if (clip === undefined) throw new Error('intro clip missing');
  return clip.startUs + clip.durationUs;
}
