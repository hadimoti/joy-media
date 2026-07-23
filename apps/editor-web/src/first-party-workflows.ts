// apps/editor-web/src/first-party-workflows.ts

import {
  buildFirstPartyWorkflows,
  firstPartyDefinitionFiles,
  FIRST_PARTY_WORKFLOWS_VERSION,
  FIRST_PARTY_WORKFLOW_IDS,
} from '@joy-media/workflow-engine';
import type { JoyWorkflow, FirstPartyDefinitionFile, FirstPartyWorkflow as WorkflowEngineFirstPartyWorkflow } from '@joy-media/workflow-engine';

/**
 * First-party workflows loaded from the workflow-engine package.
 * These are built-in workflows that ship with JOY Media.
 */

export interface FirstPartyWorkflow {
  readonly workflow: JoyWorkflow;
  readonly fileName: string;
}

let cachedWorkflows: readonly FirstPartyWorkflow[] | undefined;

export function loadFirstPartyWorkflows(): readonly FirstPartyWorkflow[] {
  if (cachedWorkflows !== undefined) return cachedWorkflows;

  // Use the builder functions from workflow-engine to get the workflows
  const builtWorkflows = buildFirstPartyWorkflows();
  const definitionFiles = firstPartyDefinitionFiles();

  cachedWorkflows = builtWorkflows.map((built, index) => ({
    workflow: built.workflow,
    fileName: definitionFiles[index]?.fileName ?? `${built.workflow.id}.json`,
  }));

  return cachedWorkflows;
}

export function getFirstPartyWorkflow(workflowId: string): FirstPartyWorkflow | undefined {
  return loadFirstPartyWorkflows().find((w) => w.workflow.id === workflowId);
}

export function getFirstPartyWorkflowVersion(): string {
  return FIRST_PARTY_WORKFLOWS_VERSION;
}

export { FIRST_PARTY_WORKFLOW_IDS };