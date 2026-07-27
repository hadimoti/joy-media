import { describe, expect, it } from 'vitest';
import type { SpikeProject } from './model.js';
import { rational } from './time.js';
import { migrateV0ToV1, migrateV1ToV2, migrateToLatest } from './migration.js';
import { validateJoyProjectV1 } from './v1.js';
import { validateJoyProjectV2, isJoyProjectV2, LATEST_PROJECT_SCHEMA_VERSION } from './v2.js';
import type { JoyProjectV2 } from './v2.js';
import {
  applyDualLensFlags,
  projectWithoutDualLens,
  readDualLensFlags,
  DUAL_LENS_FLAG_KEY,
} from './dual-lens-flag.js';
import {
  validateTemporalBinding,
  validateCreativeArtifact,
  validateWorkflowGraph,
  isRenderableArtifactKind,
  CREATIVE_CAPABILITIES,
} from './creative.js';
import type { CreativeArtifactV2, WorkflowGraphV2, WorkflowNodeV2 } from './creative.js';

/**
 * Built here rather than pulled from `@joy-media/test-fixtures`: that package
 * depends on this one, so importing it back would invert the dependency.
 */
const SPIKE: SpikeProject = {
  schemaVersion: 0,
  id: 'schema-v2-fixture',
  rootCompositionId: 'comp-root',
  compositions: {
    'comp-root': {
      id: 'comp-root',
      name: 'Reel',
      width: 1080,
      height: 1920,
      frameRate: rational(30, 1),
      durationUs: 30_000_000,
      tracks: [
        {
          id: 'track-0',
          kind: 'video',
          order: 0,
          enabled: true,
          clips: [
            {
              kind: 'video',
              id: 'intro',
              assetId: 'asset-intro',
              startUs: 0,
              durationUs: 10_000_000,
              sourceInUs: 0,
            },
            {
              kind: 'video',
              id: 'product',
              assetId: 'asset-product',
              startUs: 10_000_000,
              durationUs: 10_000_000,
              sourceInUs: 0,
            },
          ],
        },
      ],
    },
  },
};

function v1() {
  return migrateV0ToV1(SPIKE).project;
}

const SCRIPT_ARTIFACT: CreativeArtifactV2 = {
  id: 'artifact-script',
  kind: 'script',
  schemaVersion: 1,
  revision: 0,
  label: 'Reel script',
  contentRef: { type: 'inline', value: 'Open on the product.' },
  binding: { type: 'range', startUs: 0, durationUs: 10_000_000 },
  provenance: {
    sourceArtifactIds: [],
    inputHashes: [],
    createdBy: { type: 'human', id: 'hadi' },
  },
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z',
};

describe('schema v2 — Dual Lens durable slices', () => {
  describe('v1 to v2 migration', () => {
    it('produces a valid v2 document', () => {
      const { project, report } = migrateV1ToV2(v1());

      expect(validateJoyProjectV2(project)).toEqual([]);
      expect(project.schemaVersion).toBe(2);
      expect(report).toEqual({
        fromVersion: 1,
        toVersion: 2,
        defaultsApplied: ['artifacts', 'artifactVersions'],
      });
    });

    it('changes nothing an editor can see', () => {
      // The Phase 1 exit criterion: old projects migrate without visible
      // change. Everything except the version and the new containers must be
      // byte-identical, so a migrated project renders and edits as before.
      const omit = (project: object, ...keys: readonly string[]) =>
        Object.fromEntries(Object.entries(project).filter(([key]) => !keys.includes(key)));

      const before = v1();
      const { project } = migrateV1ToV2(before);

      expect(omit(project, 'schemaVersion', 'artifacts', 'artifactVersions', 'workflow')).toEqual(
        omit(before, 'schemaVersion'),
      );
      expect(project.artifacts).toEqual({});
      expect(project.artifactVersions).toEqual({});
      expect(project.workflow).toBeUndefined();
    });

    it('does not invent artifacts for media the projection already derives', () => {
      // Synthesising artifacts from existing assets would give one thing two
      // identities — the derived Flow node and the stored artifact — with no
      // rule for which one wins.
      const { project } = migrateV1ToV2(v1());

      expect(Object.keys(project.artifacts ?? {})).toEqual([]);
    });

    it('is idempotent through migrateToLatest', () => {
      const once = migrateToLatest(v1());
      const twice = migrateToLatest(once);

      expect(twice).toEqual(once);
      expect(twice.schemaVersion).toBe(LATEST_PROJECT_SCHEMA_VERSION);
      expect(isJoyProjectV2(twice)).toBe(true);
    });

    it('round trips through JSON unchanged', () => {
      const project: JoyProjectV2 = {
        ...migrateV1ToV2(v1()).project,
        artifacts: { 'artifact-script': SCRIPT_ARTIFACT },
      };
      const restored = JSON.parse(JSON.stringify(project)) as JoyProjectV2;

      expect(restored).toEqual(project);
      expect(validateJoyProjectV2(restored)).toEqual([]);
    });
  });

  describe('the flag has a provable off state', () => {
    it('hands a v1 document to a disabled consumer even if graph state exists', () => {
      const project: JoyProjectV2 = {
        ...migrateV1ToV2(v1()).project,
        artifacts: { 'artifact-script': SCRIPT_ARTIFACT },
        workflow: { schemaVersion: 1, nodes: [], edges: [] },
      };

      const disabled = applyDualLensFlags(project, { graphEnabled: false });

      expect(disabled).toEqual(v1());
      expect(validateJoyProjectV1(disabled)).toEqual([]);
      expect('artifacts' in disabled).toBe(false);
      expect('workflow' in disabled).toBe(false);
    });

    it('passes the v2 document through when enabled', () => {
      const project = migrateV1ToV2(v1()).project;

      expect(applyDualLensFlags(project, { graphEnabled: true })).toBe(project);
    });

    it('does not mutate the project it strips', () => {
      const project: JoyProjectV2 = {
        ...migrateV1ToV2(v1()).project,
        artifacts: { 'artifact-script': SCRIPT_ARTIFACT },
      };
      projectWithoutDualLens(project);

      expect(project.artifacts).toEqual({ 'artifact-script': SCRIPT_ARTIFACT });
    });

    it('defaults off and fails closed on anything but "on"', () => {
      expect(readDualLensFlags(undefined).graphEnabled).toBe(false);
      expect(readDualLensFlags({ getItem: () => null }).graphEnabled).toBe(false);
      expect(readDualLensFlags({ getItem: () => 'true' }).graphEnabled).toBe(false);
      expect(readDualLensFlags({ getItem: () => 'on' }).graphEnabled).toBe(true);
    });

    it('survives a storage that throws', () => {
      const hostile = {
        getItem() {
          throw new Error('storage disabled');
        },
      };

      expect(readDualLensFlags(hostile).graphEnabled).toBe(false);
    });

    it('reads the documented key', () => {
      const seen: string[] = [];
      readDualLensFlags({
        getItem: (key) => {
          seen.push(key);
          return null;
        },
      });

      expect(seen).toEqual([DUAL_LENS_FLAG_KEY]);
    });
  });

  describe('document-level validation', () => {
    it('rejects an artifact whose key disagrees with its id', () => {
      const project = {
        ...migrateV1ToV2(v1()).project,
        artifacts: { 'wrong-key': SCRIPT_ARTIFACT },
      };

      expect(validateJoyProjectV2(project).map((d) => d.code)).toContain(
        'PROJECT_SCHEMA_V2_ARTIFACT_KEY',
      );
    });

    it('rejects versions of an artifact that does not exist', () => {
      const project = {
        ...migrateV1ToV2(v1()).project,
        artifacts: {},
        artifactVersions: { 'artifact-ghost': [] },
      };

      expect(validateJoyProjectV2(project).map((d) => d.code)).toContain(
        'PROJECT_SCHEMA_V2_VERSION_ORPHAN',
      );
    });

    it('still reports v1 body problems, without the v1 version complaint', () => {
      const broken = { ...migrateV1ToV2(v1()).project, title: '' };
      const codes = validateJoyProjectV2(broken).map((d) => d.code);

      expect(codes).toContain('PROJECT_SCHEMA_V1_TITLE');
      expect(codes).not.toContain('PROJECT_SCHEMA_V1_VERSION');
    });
  });
});

describe('creative artifact contracts', () => {
  it('accepts a well-formed artifact', () => {
    expect(validateCreativeArtifact(SCRIPT_ARTIFACT, 'a')).toEqual([]);
  });

  it('requires a model whenever a provider is claimed', () => {
    const artifact = {
      ...SCRIPT_ARTIFACT,
      provenance: { ...SCRIPT_ARTIFACT.provenance, providerId: 'local-worker' },
    };

    expect(validateCreativeArtifact(artifact, 'a').map((d) => d.code)).toContain(
      'PROVENANCE_MODEL',
    );
  });

  it('keeps non-renderable data out of the render path', () => {
    // §5.4: analysis, prompts, and change sets influence renderable artifacts
    // through commands; they must never become fake layers.
    expect(isRenderableArtifactKind('video')).toBe(true);
    expect(isRenderableArtifactKind('generatedMedia')).toBe(true);
    expect(isRenderableArtifactKind('analysis')).toBe(false);
    expect(isRenderableArtifactKind('prompt')).toBe(false);
    expect(isRenderableArtifactKind('changeSet')).toBe(false);
    expect(isRenderableArtifactKind('script')).toBe(false);
  });
});

describe('temporal bindings', () => {
  it('accepts each placed form', () => {
    expect(validateTemporalBinding({ type: 'global' }, 'b')).toEqual([]);
    expect(validateTemporalBinding({ type: 'none' }, 'b')).toEqual([]);
    expect(validateTemporalBinding({ type: 'point', timeUs: 0 }, 'b')).toEqual([]);
    expect(
      validateTemporalBinding({ type: 'range', startUs: 0, durationUs: 1 }, 'b'),
    ).toEqual([]);
  });

  it('rejects a zero-length range, which is a point wearing the wrong type', () => {
    expect(
      validateTemporalBinding({ type: 'range', startUs: 0, durationUs: 0 }, 'b').map(
        (d) => d.code,
      ),
    ).toEqual(['BINDING_RANGE_DURATION']);
  });

  it('rejects float and negative microseconds', () => {
    // ADR-0002: durable time is integer microseconds, never float seconds.
    expect(validateTemporalBinding({ type: 'point', timeUs: 1.5 }, 'b')).toHaveLength(1);
    expect(validateTemporalBinding({ type: 'point', timeUs: -1 }, 'b')).toHaveLength(1);
  });

  it('rejects an unknown binding type', () => {
    expect(validateTemporalBinding({ type: 'whenever' }, 'b').map((d) => d.code)).toEqual([
      'BINDING_KIND',
    ]);
  });
});

describe('workflow graph contracts', () => {
  const node = (
    id: string,
    outputs: string[] = ['out'],
    inputs: string[] = ['in'],
  ): WorkflowNodeV2 => ({
    id,
    type: 'transform.trim',
    schemaVersion: 1,
    label: id,
    inputs: inputs.map((p) => ({ id: p, label: p, dataType: 'VideoArtifact', required: true })),
    outputs: outputs.map((p) => ({ id: p, label: p, dataType: 'VideoArtifact', required: true })),
    config: {},
    executionPolicy: { requiredCapabilities: ['timeline.write'], requiresApproval: false },
  });

  const edge = (id: string, from: string, to: string) => ({
    id,
    fromNodeId: from,
    fromPortId: 'out',
    toNodeId: to,
    toPortId: 'in',
  });

  it('accepts a valid DAG', () => {
    const graph: WorkflowGraphV2 = {
      schemaVersion: 1,
      nodes: [node('a'), node('b')],
      edges: [edge('e1', 'a', 'b')],
    };

    expect(validateWorkflowGraph(graph, 'workflow')).toEqual([]);
  });

  it('rejects a cycle at the document level, not only at execution', () => {
    // A storable cycle would fail much later, far from the edit that caused it.
    const graph = {
      schemaVersion: 1,
      nodes: [node('a'), node('b')],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')],
    };

    expect(validateWorkflowGraph(graph, 'workflow').map((d) => d.code)).toContain('GRAPH_CYCLE');
  });

  it('rejects a self-edge', () => {
    const graph = { schemaVersion: 1, nodes: [node('a')], edges: [edge('e1', 'a', 'a')] };

    expect(validateWorkflowGraph(graph, 'workflow').map((d) => d.code)).toContain('GRAPH_CYCLE');
  });

  it('rejects an edge to a node that is not in the graph', () => {
    const graph = { schemaVersion: 1, nodes: [node('a')], edges: [edge('e1', 'a', 'ghost')] };

    expect(validateWorkflowGraph(graph, 'workflow').map((d) => d.code)).toContain('GRAPH_EDGE_TO');
  });

  it('rejects an edge to a port the node does not declare', () => {
    const graph = {
      schemaVersion: 1,
      nodes: [node('a'), node('b')],
      edges: [{ id: 'e1', fromNodeId: 'a', fromPortId: 'nope', toNodeId: 'b', toPortId: 'in' }],
    };

    expect(validateWorkflowGraph(graph, 'workflow').map((d) => d.code)).toContain(
      'GRAPH_EDGE_FROM_PORT',
    );
  });

  it('rejects duplicate node ids', () => {
    const graph = { schemaVersion: 1, nodes: [node('a'), node('a')], edges: [] };

    expect(validateWorkflowGraph(graph, 'workflow').map((d) => d.code)).toContain(
      'GRAPH_NODE_DUPLICATE',
    );
  });

  it('rejects a capability outside the shared vocabulary', () => {
    const rogue = {
      ...node('a'),
      executionPolicy: { requiredCapabilities: ['timeline.destroy'], requiresApproval: false },
    };

    expect(validateWorkflowGraph({ schemaVersion: 1, nodes: [rogue], edges: [] }, 'w').map(
      (d) => d.code,
    )).toContain('GRAPH_NODE_CAPABILITY_UNKNOWN');
  });

  it('accepts every capability in the shared vocabulary', () => {
    const permissive = {
      ...node('a'),
      executionPolicy: { requiredCapabilities: CREATIVE_CAPABILITIES, requiresApproval: true },
    };

    expect(validateWorkflowGraph({ schemaVersion: 1, nodes: [permissive], edges: [] }, 'w')).toEqual(
      [],
    );
  });
});
