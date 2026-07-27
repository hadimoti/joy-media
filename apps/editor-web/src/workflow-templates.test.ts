import { describe, expect, it } from 'vitest';
import {
  applyGraphTransaction,
  revertGraphTransaction,
  dryRunGraphTransaction,
} from '@joy-media/commands';
import { EMPTY_WORKFLOW_GRAPH, validateWorkflowGraph } from '@joy-media/project-schema';
import {
  WORKFLOW_TEMPLATES,
  buildTemplateTransaction,
  workflowTemplateFor,
} from './workflow-templates.js';
import { templateFor } from './workflow-node-catalog.js';

const SEED = { seed: 'abc123' };

describe('workflow templates', () => {
  describe('every template builds a graph the command bus accepts', () => {
    it.each(WORKFLOW_TEMPLATES.map((t) => [t.id, t] as const))(
      '%s applies cleanly',
      (_id, template) => {
        // The real assertion: ports must be compatible end to end, or
        // graph.edge.connect refuses and this throws.
        const { graph } = applyGraphTransaction(
          EMPTY_WORKFLOW_GRAPH,
          buildTemplateTransaction(template, SEED),
        );

        expect(graph.nodes).toHaveLength(template.nodes.length);
        expect(graph.edges).toHaveLength(template.links.length);
        expect(validateWorkflowGraph(graph, 'workflow')).toEqual([]);
      },
    );

    it.each(WORKFLOW_TEMPLATES.map((t) => [t.id, t] as const))(
      '%s reverts in one undo',
      (_id, template) => {
        const { graph, record } = applyGraphTransaction(
          EMPTY_WORKFLOW_GRAPH,
          buildTemplateTransaction(template, SEED),
        );

        expect(revertGraphTransaction(graph, record)).toEqual(EMPTY_WORKFLOW_GRAPH);
      },
    );

    it.each(WORKFLOW_TEMPLATES.map((t) => [t.id, t] as const))(
      '%s names only node types that exist',
      (_id, template) => {
        expect(template.nodes.filter((type) => templateFor(type) === undefined)).toEqual([]);
      },
    );
  });

  describe('the shapes the plan actually draws', () => {
    it('runs two specialists in parallel into one gate for Reel Finish', () => {
      // §11.2. A linear chain could not express this, and would not type-check:
      // colour review's change set is not something audio cleanup can read.
      const template = workflowTemplateFor('reel-finish')!;
      const { graph } = applyGraphTransaction(
        EMPTY_WORKFLOW_GRAPH,
        buildTemplateTransaction(template, SEED),
      );
      const gate = graph.nodes.find((node) => node.type === 'review.gate')!;
      const intoGate = graph.edges.filter((edge) => edge.toNodeId === gate.id);

      expect(intoGate).toHaveLength(2);
      const sources = intoGate
        .map((edge) => graph.nodes.find((node) => node.id === edge.fromNodeId)?.type)
        .sort();
      expect(sources).toEqual(['agent.audioCleanup', 'agent.colorReview']);
    });

    it('forks one recording into caption and cleanup branches for Podcast Cleanup', () => {
      const template = workflowTemplateFor('podcast-cleanup')!;
      const { graph } = applyGraphTransaction(
        EMPTY_WORKFLOW_GRAPH,
        buildTemplateTransaction(template, SEED),
      );
      const audio = graph.nodes.find((node) => node.type === 'source.audio')!;
      const downstream = graph.edges
        .filter((edge) => edge.fromNodeId === audio.id)
        .map((edge) => graph.nodes.find((node) => node.id === edge.toNodeId)?.type)
        .sort();

      expect(downstream).toEqual(['analysis.silence', 'analysis.transcribe']);
    });

    it('declares provider spend on Generate B-roll so policy can gate it first', () => {
      const template = workflowTemplateFor('generate-broll')!;
      const { graph } = applyGraphTransaction(
        EMPTY_WORKFLOW_GRAPH,
        buildTemplateTransaction(template, SEED),
      );
      const generator = graph.nodes.find((node) => node.type === 'generative.video')!;

      expect(generator.executionPolicy.requiredCapabilities).toContain('provider.spend');
      expect(generator.executionPolicy.requiresApproval).toBe(true);
    });

    it('puts a review gate before every write to the sequence', () => {
      for (const template of WORKFLOW_TEMPLATES) {
        const { graph } = applyGraphTransaction(
          EMPTY_WORKFLOW_GRAPH,
          buildTemplateTransaction(template, SEED),
        );
        const writers = graph.nodes.filter((node) =>
          node.executionPolicy.requiredCapabilities.includes('timeline.write'),
        );
        expect(writers.every((node) => node.executionPolicy.requiresApproval)).toBe(true);
      }
    });
  });

  describe('determinism and reuse', () => {
    it('produces the same graph for the same seed', () => {
      const template = workflowTemplateFor('auto-captions')!;

      expect(buildTemplateTransaction(template, SEED)).toEqual(
        buildTemplateTransaction(template, SEED),
      );
    });

    it('can be applied twice without colliding ids', () => {
      const template = workflowTemplateFor('auto-captions')!;
      const first = applyGraphTransaction(
        EMPTY_WORKFLOW_GRAPH,
        buildTemplateTransaction(template, { seed: 'one' }),
      ).graph;

      const second = applyGraphTransaction(
        first,
        buildTemplateTransaction(template, { seed: 'two' }),
      ).graph;

      expect(second.nodes).toHaveLength(template.nodes.length * 2);
      expect(validateWorkflowGraph(second, 'workflow')).toEqual([]);
    });

    it('refuses a second copy under the same seed rather than duplicating ids', () => {
      const template = workflowTemplateFor('auto-captions')!;
      const graph = applyGraphTransaction(
        EMPTY_WORKFLOW_GRAPH,
        buildTemplateTransaction(template, SEED),
      ).graph;

      const preview = dryRunGraphTransaction(graph, buildTemplateTransaction(template, SEED));

      expect(preview.ok).toBe(false);
      expect(preview.errors[0]).toMatch(/already exists/);
    });

    it('labels nodes with the scope it was created for', () => {
      const template = workflowTemplateFor('auto-captions')!;
      const { graph } = applyGraphTransaction(
        EMPTY_WORKFLOW_GRAPH,
        buildTemplateTransaction(template, { seed: 'x', scopeLabel: '3 clips' }),
      );

      expect(graph.nodes.every((node) => node.label.endsWith('· 3 clips'))).toBe(true);
    });
  });
});
