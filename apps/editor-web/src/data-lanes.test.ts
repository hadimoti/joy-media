import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import {
  DUAL_LENS_FLAG_KEY,
  EMPTY_WORKFLOW_GRAPH,
  selectRenderableArtifacts,
} from '@joy-media/project-schema';
import type { CreativeArtifactV2, WorkflowGraphV2 } from '@joy-media/project-schema';
import { EMPTY_ARTIFACT_STORE } from '@joy-media/commands';
import type { ArtifactStore } from '@joy-media/commands';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession } from './editor-session.js';
import { buildDataLanes, countLaneItems } from './data-lanes.js';

function artifact(
  id: string,
  kind: CreativeArtifactV2['kind'],
  overrides: Partial<CreativeArtifactV2> = {},
): CreativeArtifactV2 {
  return {
    id,
    kind,
    schemaVersion: 1,
    revision: 0,
    label: id,
    contentRef: { type: 'inline', value: 'content' },
    binding: { type: 'none' },
    provenance: { sourceArtifactIds: [], inputHashes: [], createdBy: { type: 'human', id: 'hadi' } },
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

function storeOf(...artifacts: CreativeArtifactV2[]): ArtifactStore {
  return { artifacts: Object.fromEntries(artifacts.map((a) => [a.id, a])), versions: {} };
}

function lanes(artifacts: ArtifactStore, graph: WorkflowGraphV2 = EMPTY_WORKFLOW_GRAPH) {
  return buildDataLanes({ artifacts, graph, creative: INITIAL_EDITOR_PROJECT });
}

describe('data lanes', () => {
  describe('uncluttered by default', () => {
    it('shows no artifact lanes for a project with no artifacts', () => {
      // The reference project still has caption clips, so captions appear; the
      // point is that nothing else invents a row.
      const built = lanes(EMPTY_ARTIFACT_STORE);

      expect(built.map((lane) => lane.kind)).toEqual(['captions']);
    });

    it('omits empty lanes rather than rendering a row of nothing', () => {
      const built = lanes(storeOf(artifact('s', 'script')));

      expect(built.map((lane) => lane.kind).sort()).toEqual(['captions', 'script']);
      expect(built.every((lane) => lane.items.length > 0)).toBe(true);
    });

    it('does not repeat plain media that already appears on the tracks', () => {
      const built = lanes(storeOf(artifact('v', 'video'), artifact('meta', 'metadata')));

      expect(built.map((lane) => lane.kind)).toEqual(['captions']);
    });
  });

  describe('placement', () => {
    it('places a range-bound artifact at its own time', () => {
      const built = lanes(
        storeOf(
          artifact('p', 'prompt', {
            binding: { type: 'range', startUs: 12_000_000, durationUs: 16_000_000 },
          }),
        ),
      );
      const item = built.find((lane) => lane.kind === 'prompt')?.items[0];

      expect(item?.startUs).toBe(12_000_000);
      expect(item?.durationUs).toBe(16_000_000);
    });

    it('keeps an unplaced artifact visible instead of dropping it', () => {
      // "We have a script but it is not attached yet" is information the editor
      // needs; hiding it would make the drawer lie about the project.
      const item = lanes(storeOf(artifact('s', 'script'))).find((l) => l.kind === 'script')
        ?.items[0];

      expect(item).toBeDefined();
      expect(item?.startUs).toBeUndefined();
    });

    it('sorts placed items by time and puts unplaced ones last', () => {
      const built = lanes(
        storeOf(
          artifact('late', 'analysis', {
            binding: { type: 'range', startUs: 9_000_000, durationUs: 1_000_000 },
          }),
          artifact('floating', 'analysis'),
          artifact('early', 'analysis', {
            binding: { type: 'range', startUs: 1_000_000, durationUs: 1_000_000 },
          }),
        ),
      );

      expect(built.find((l) => l.kind === 'analysis')?.items.map((i) => i.label)).toEqual([
        'early',
        'late',
        'floating',
      ]);
    });

    it('gives a point binding a zero duration rather than treating it as unplaced', () => {
      const item = lanes(
        storeOf(artifact('a', 'analysis', { binding: { type: 'point', timeUs: 5_000_000 } })),
      ).find((l) => l.kind === 'analysis')?.items[0];

      expect(item?.startUs).toBe(5_000_000);
      expect(item?.durationUs).toBe(0);
    });
  });

  describe('partial invalidation', () => {
    it('marks an artifact stale when the node that produced it is stale', () => {
      const graph: WorkflowGraphV2 = {
        schemaVersion: 1,
        nodes: [
          {
            id: 'n1',
            type: 'analysis.transcribe',
            schemaVersion: 1,
            label: 'Transcribe',
            inputs: [],
            outputs: [],
            config: {},
            executionPolicy: { requiredCapabilities: [], requiresApproval: false },
            status: 'stale',
          },
        ],
        edges: [],
      };
      const built = buildDataLanes({
        artifacts: storeOf(
          artifact('t', 'transcript', {
            provenance: {
              sourceArtifactIds: [],
              inputHashes: [],
              createdBy: { type: 'agent', id: 'kilocode' },
              workflowNodeId: 'n1',
            },
          }),
          artifact('other', 'analysis'),
        ),
        graph,
        creative: INITIAL_EDITOR_PROJECT,
      });

      expect(built.find((l) => l.kind === 'transcript')?.items[0]?.stale).toBe(true);
      // An unrelated artifact must not be dragged into the invalidation.
      expect(built.find((l) => l.kind === 'analysis')?.items[0]?.stale).toBe(false);
    });

    it('surfaces approval gates and running work as their own lanes', () => {
      const graph: WorkflowGraphV2 = {
        schemaVersion: 1,
        nodes: [
          {
            id: 'gate',
            type: 'output.captionTrack',
            schemaVersion: 1,
            label: 'Caption track',
            inputs: [],
            outputs: [],
            config: {},
            executionPolicy: { requiredCapabilities: ['timeline.write'], requiresApproval: true },
            status: 'running',
          },
        ],
        edges: [],
      };
      const built = buildDataLanes({
        artifacts: EMPTY_ARTIFACT_STORE,
        graph,
        creative: INITIAL_EDITOR_PROJECT,
      });

      expect(built.map((l) => l.kind)).toEqual(expect.arrayContaining(['reviewGate', 'workflow']));
    });
  });

  describe('non-renderable data never reaches Render IR', () => {
    it('drops everything that is not renderable media', () => {
      const store = storeOf(
        artifact('script', 'script'),
        artifact('prompt', 'prompt'),
        artifact('analysis', 'analysis'),
        artifact('changes', 'changeSet'),
        artifact('shot', 'generatedMedia'),
        artifact('clip', 'video'),
      );

      const renderable = selectRenderableArtifacts(Object.values(store.artifacts)).map((a) => a.id);

      expect(renderable.sort()).toEqual(['clip', 'shot']);
    });

    it('still shows the non-renderable ones as data', () => {
      // They are visible and editable — just never handed to the renderer.
      const built = lanes(storeOf(artifact('script', 'script'), artifact('prompt', 'prompt')));

      expect(countLaneItems(built)).toBeGreaterThanOrEqual(2);
    });
  });

  describe('one document', () => {
    it('data edits go through the same history as timeline edits', () => {
      const storage = (() => {
        const values = new Map<string, string>([[DUAL_LENS_FLAG_KEY, 'on']]);
        return {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => values.set(key, value),
        };
      })();
      const session = new EditorSession(
        storage,
        buildReferenceSpikeProject(),
        INITIAL_EDITOR_PROJECT,
      );

      session.dispatchArtifacts({
        label: 'Add script',
        commands: [{ type: 'artifact.create', payload: { artifact: artifact('s', 'script') } }],
      });
      expect(Object.keys(session.artifacts.artifacts)).toEqual(['s']);

      const entry = session.historyEntries.find((e) => e.label === 'Add script');
      expect(entry?.source).toBe('artifact');

      session.undo();
      expect(Object.keys(session.artifacts.artifacts)).toEqual([]);

      session.redo();
      expect(Object.keys(session.artifacts.artifacts)).toEqual(['s']);
    });

    it('refuses artifact edits when the flag is off', () => {
      const storage = (() => {
        const values = new Map<string, string>();
        return {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => values.set(key, value),
        };
      })();
      const session = new EditorSession(
        storage,
        buildReferenceSpikeProject(),
        INITIAL_EDITOR_PROJECT,
      );

      expect(() =>
        session.dispatchArtifacts({
          label: 'Add script',
          commands: [{ type: 'artifact.create', payload: { artifact: artifact('s', 'script') } }],
        }),
      ).toThrow(/disabled/);
    });
  });
});
