/**
 * The node types the Flow editor can author.
 *
 * Port `dataType`s are real: an audio source cannot feed a caption track
 * directly, because the chain has to pass through transcription and styling
 * first. That makes the type check in `graph.edge.connect` something the user
 * actually meets rather than a rule only tests exercise.
 *
 * This catalog is UI-side on purpose. Persisted nodes carry their own ports
 * (ADR-0023), so a project authored today still validates after this list
 * changes — the catalog seeds nodes, it does not define them.
 */

import type { WorkflowNodeV2 } from '@joy-media/project-schema';

export interface WorkflowNodeTemplate {
  readonly type: string;
  readonly label: string;
  readonly hint: string;
  readonly build: (id: string) => WorkflowNodeV2;
}

function template(
  type: string,
  label: string,
  hint: string,
  inputs: WorkflowNodeV2['inputs'],
  outputs: WorkflowNodeV2['outputs'],
  requiredCapabilities: WorkflowNodeV2['executionPolicy']['requiredCapabilities'],
  requiresApproval = false,
): WorkflowNodeTemplate {
  return {
    type,
    label,
    hint,
    build: (id) => ({
      id,
      type,
      schemaVersion: 1,
      label,
      inputs,
      outputs,
      config: {},
      executionPolicy: { requiredCapabilities, requiresApproval },
    }),
  };
}

export const WORKFLOW_NODE_TEMPLATES: readonly WorkflowNodeTemplate[] = [
  template(
    'source.audio',
    'Dialogue audio',
    'Audio taken from the sequence.',
    [],
    [{ id: 'out', label: 'Audio', dataType: 'AudioArtifact', required: true }],
    ['timeline.read'],
  ),
  template(
    'analysis.transcribe',
    'Transcribe',
    'Speech to word-level transcript.',
    [{ id: 'in', label: 'Audio', dataType: 'AudioArtifact', required: true }],
    [{ id: 'out', label: 'Transcript', dataType: 'Transcript', required: true }],
    ['timeline.read'],
  ),
  template(
    'transform.captionStyle',
    'Caption style',
    'Segments and styles a transcript.',
    [
      {
        id: 'in',
        label: 'Transcript',
        dataType: 'CaptionDocument',
        required: true,
        accepts: ['Transcript'],
      },
    ],
    [{ id: 'out', label: 'Captions', dataType: 'CaptionDocument', required: true }],
    ['timeline.read'],
  ),
  template(
    'agent.colorReview',
    'Color review',
    'Specialist proposes a grade change set.',
    [{ id: 'in', label: 'Sequence', dataType: 'VideoArtifact', required: true }],
    [{ id: 'out', label: 'Change set', dataType: 'ChangeSet', required: true }],
    ['timeline.read', 'provider.generate'],
    true,
  ),
  template(
    'output.captionTrack',
    'Caption track',
    'Writes captions back to the timeline.',
    [{ id: 'in', label: 'Captions', dataType: 'CaptionDocument', required: true }],
    [],
    ['timeline.write'],
    true,
  ),
];

export function templateFor(type: string): WorkflowNodeTemplate | undefined {
  return WORKFLOW_NODE_TEMPLATES.find((candidate) => candidate.type === type);
}
