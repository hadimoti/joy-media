// apps/editor-web/src/first-party-workflows.ts

import {
  buildFirstPartyWorkflows,
  firstPartyDefinitionFiles,
  FIRST_PARTY_WORKFLOWS_VERSION,
  FIRST_PARTY_WORKFLOW_IDS,
} from '@joy-media/workflow-engine';
import type { JoyWorkflow } from '@joy-media/workflow-engine';
import type { RecordedWorkflow } from './workflow-recorder.js';

/**
 * First-party workflows loaded from `@joy-media/workflow-engine` (D-W17-1a:
 * bundled via the workspace package — same artifact the CLI/tests pin).
 */

export interface FirstPartyWorkflow {
  readonly workflow: JoyWorkflow;
  readonly fileName: string;
}

let cachedWorkflows: readonly FirstPartyWorkflow[] | undefined;

export function loadFirstPartyWorkflows(): readonly FirstPartyWorkflow[] {
  if (cachedWorkflows !== undefined) return cachedWorkflows;

  const builtWorkflows = buildFirstPartyWorkflows();
  const definitionFiles = firstPartyDefinitionFiles();

  cachedWorkflows = builtWorkflows.map((built, index) => ({
    workflow: built.workflow,
    fileName: definitionFiles[index]?.fileName ?? `${built.workflow.id}.json`,
  }));

  return cachedWorkflows;
}

export function getFirstPartyWorkflow(workflowId: string): FirstPartyWorkflow | undefined {
  return loadFirstPartyWorkflows().find((entry) => entry.workflow.id === workflowId);
}

export function getFirstPartyWorkflowVersion(): string {
  return FIRST_PARTY_WORKFLOWS_VERSION;
}

/**
 * WP-17.3 — surface lineage when a recorded workflow's goal/name references a
 * first-party system workflow. Exact recording-from-system lineage lands later;
 * this makes teachable reuse visible without inventing false provenance.
 */
export function detectDerivedFrom(recorded: RecordedWorkflow): string | undefined {
  const haystack = `${recorded.workflow.name} ${recorded.originalPlan.goal}`.toLowerCase();
  for (const id of FIRST_PARTY_WORKFLOW_IDS) {
    const short = id.replace('joy.first-party.', '').replaceAll('-', ' ');
    if (haystack.includes(id.toLowerCase()) || haystack.includes(short)) {
      return id;
    }
  }
  const firstStep = recorded.originalPlan.steps[0];
  if (firstStep !== undefined) {
    const stepHaystack = `${firstStep.tool} ${firstStep.description}`.toLowerCase();
    for (const id of FIRST_PARTY_WORKFLOW_IDS) {
      const short = id.replace('joy.first-party.', '').replaceAll('-', ' ');
      if (stepHaystack.includes(short)) {
        return id;
      }
    }
  }
  return undefined;
}

export { FIRST_PARTY_WORKFLOW_IDS };
