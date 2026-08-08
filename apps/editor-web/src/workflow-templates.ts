/**
 * Workflow templates (plan §11, §16 Phase 6).
 *
 * A template is not a saved graph — it is a *transaction* that builds one. That
 * matters twice over. Everything Phase 3 established still applies: the result
 * is validated, type-checked port by port, and lands as a single undo. And a
 * template can be seeded against the current selection instead of being a fixed
 * picture that only fits one project.
 *
 * Nodes and links are declared separately rather than as a chain, because two
 * of these are not chains: Reel Finish runs two specialists in parallel into
 * one gate (§11.2), and Podcast Cleanup forks the same audio into a caption
 * branch and a cleanup branch (§11.4). A linear model would have forced those
 * into a line that does not type-check — colour review's change set is not
 * something audio cleanup can read.
 *
 * These connect only because the ports are genuinely compatible; the graph
 * command bus enforces that, rather than the template asserting it.
 */

import type { GraphTransaction, WorkflowGraphCommand } from '@joy-media/commands';
import type { WorkflowNodeV2 } from '@joy-media/project-schema';
import { templateFor } from './workflow-node-catalog.js';

export interface WorkflowTemplate {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Node types, addressed by index below. */
  readonly nodes: readonly string[];
  readonly links: readonly (readonly [fromIndex: number, toIndex: number])[];
}

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: 'auto-captions',
    label: 'Auto Captions',
    description: 'Dialogue audio → transcript → caption style → caption track.',
    nodes: ['source.audio', 'analysis.transcribe', 'transform.captionStyle', 'output.captionTrack'],
    links: [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
  },
  {
    id: 'podcast-cleanup',
    label: 'Podcast Cleanup',
    description: 'Captions and level cleanup from one recording, held for approval.',
    nodes: [
      'source.audio',
      'analysis.transcribe',
      'transform.captionStyle',
      'output.captionTrack',
      'analysis.silence',
      'agent.audioCleanup',
      'review.gate',
      'output.sequenceUpdate',
    ],
    // The recording feeds two independent branches; silence detection reads the
    // audio directly, not the transcript.
    links: [
      [0, 1],
      [1, 2],
      [2, 3],
      [0, 4],
      [4, 5],
      [5, 6],
      [6, 7],
    ],
  },
  {
    id: 'reel-finish',
    label: 'Reel Finish',
    description: 'Colour and audio specialists review in parallel into one gate.',
    nodes: [
      'source.sequence',
      'agent.colorReview',
      'agent.audioCleanup',
      'review.gate',
      'output.sequenceUpdate',
    ],
    // Two specialists from the same sequence into one gate: the combined
    // change set of §11.2, and the reason the gate's input takes multiple.
    links: [
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 3],
      [3, 4],
    ],
  },
  {
    id: 'generate-broll',
    label: 'Generate B-roll',
    description: 'Script range → shot brief → provider → versions → insert.',
    nodes: [
      'source.script',
      'transform.shotBrief',
      'generative.video',
      'composition.versionSelector',
      'output.insertAtPlayhead',
    ],
    links: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ],
  },
];

export interface TemplateSeed {
  /** Distinguishes ids when the same template is applied twice. */
  readonly seed: string;
  /** Appears in node labels so a template instance names its scope. */
  readonly scopeLabel?: string;
  /**
   * Time the workflow was created for. Bound to the source nodes only — the
   * nodes downstream derive their time from what they receive, so binding them
   * too would assert a range the workflow has not established yet.
   */
  readonly range?: { readonly startUs: number; readonly durationUs: number };
}

/**
 * Builds the transaction that creates a template's nodes and edges.
 *
 * Ids are derived from the seed rather than generated, so the same seed
 * produces the same graph — the determinism ADR-0003 requires for replay.
 */
export function buildTemplateTransaction(
  template: WorkflowTemplate,
  seed: TemplateSeed,
): GraphTransaction {
  const nodes: (WorkflowNodeV2 | undefined)[] = [];
  const commands: WorkflowGraphCommand[] = [];

  template.nodes.forEach((type, index) => {
    const definition = templateFor(type);
    if (definition === undefined) {
      // Keep the slot so later link indices still address the right nodes.
      nodes.push(undefined);
      return;
    }
    const node = definition.build(`${template.id}-${index}-${seed.seed}`);
    const labelled: WorkflowNodeV2 = {
      ...node,
      ...(seed.scopeLabel === undefined ? {} : { label: `${node.label} · ${seed.scopeLabel}` }),
      // Sources are the nodes that read the project directly, so they are the
      // ones a selection actually scopes.
      ...(seed.range !== undefined && type.startsWith('source.')
        ? {
            binding: {
              type: 'range' as const,
              startUs: seed.range.startUs,
              durationUs: seed.range.durationUs,
            },
          }
        : {}),
    };
    nodes.push(labelled);
    commands.push({ type: 'graph.node.create', payload: { node: labelled } });
  });

  for (const [fromIndex, toIndex] of template.links) {
    const from = nodes[fromIndex];
    const to = nodes[toIndex];
    const fromPort = from?.outputs[0];
    const toPort = to?.inputs[0];
    if (from === undefined || to === undefined || fromPort === undefined || toPort === undefined) {
      continue;
    }
    commands.push({
      type: 'graph.edge.connect',
      payload: {
        edge: {
          id: `${from.id}->${to.id}`,
          fromNodeId: from.id,
          fromPortId: fromPort.id,
          toNodeId: to.id,
          toPortId: toPort.id,
        },
      },
    });
  }

  return { label: `Create ${template.label} workflow`, commands };
}

export function workflowTemplateFor(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((candidate) => candidate.id === id);
}
