import { describe, expect, it } from 'vitest';
import { makeVideoClip, SECOND_US } from '@joy-media/test-fixtures';
import { createPlan, type AgentPlanStep } from '@joy-media/agent-tools';
import { convertPlanToWorkflow, deleteWorkflow, loadWorkflow, listWorkflows, saveWorkflow } from './workflow-recorder.js';

describe('workflow-recorder', () => {
  it('converts a single-step plan to a JoyWorkflow', () => {
    const step: AgentPlanStep = {
      id: 'step-1',
      description: 'Insert a clip at the end of track-0',
      mode: 'command',
      tool: 'insertClip',
      arguments: {
        compositionId: 'root',
        trackId: 'track-0',
        clip: { ...makeVideoClip('agent-clip-1', 30 * SECOND_US, 5 * SECOND_US) },
      },
      dependsOn: [],
      expectedChange: 'Insert agent-clip-1',
      preconditions: [],
      requiresConfirmation: false,
    };
    const plan = createPlan('Add agent clip to timeline', [step]);
    const workflow = convertPlanToWorkflow(plan);

    expect(workflow.formatVersion).toBe(1);
    expect(workflow.id).toBe('user.workflows.add-agent-clip-to-timeline');
    expect(workflow.version).toBe('1.0.0');
    expect(workflow.nodes).toHaveLength(1);
    expect(workflow.nodes[0]?.type).toBe('editor.commandTransaction');
    expect(workflow.edges).toHaveLength(0);
  });

  it('saves, loads, lists, and deletes a recorded workflow', () => {
    const step: AgentPlanStep = {
      id: 'step-1',
      description: 'Insert a clip',
      mode: 'command',
      tool: 'insertClip',
      arguments: {
        compositionId: 'root',
        trackId: 'track-0',
        clip: { ...makeVideoClip('agent-clip-1', 30 * SECOND_US, 5 * SECOND_US) },
      },
      dependsOn: [],
      expectedChange: 'Insert agent-clip-1',
      preconditions: [],
      requiresConfirmation: false,
    };
    const plan = createPlan('Save workflow test', [step]);
    const recorded = saveWorkflow(null, plan);
    expect(recorded.workflow.id).toBe('user.workflows.save-workflow-test');

    const loaded = loadWorkflow(null, recorded.workflow.id);
    expect(loaded).toBeDefined();
    expect(loaded!.workflow.id).toBe(recorded.workflow.id);
    expect(loaded!.originalPlan.planId).toBe(plan.planId);

    const all = listWorkflows(null);
    expect(all.some((wf) => wf.workflow.id === recorded.workflow.id)).toBe(true);

    deleteWorkflow(null, recorded.workflow.id);
    expect(loadWorkflow(null, recorded.workflow.id)).toBeUndefined();
  });
});
