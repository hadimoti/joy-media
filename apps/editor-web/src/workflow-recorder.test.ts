import { describe, expect, it } from 'vitest';
import { makeVideoClip, SECOND_US } from '@joy-media/test-fixtures';
import { createPlan, type AgentPlanStep } from '@joy-media/agent-tools';
import {
  convertPlanToWorkflow,
  deleteWorkflow,
  loadWorkflow,
  listWorkflows,
  resolveParameterizedValue,
  saveWorkflow,
  type WorkflowStorage,
} from './workflow-recorder.js';

function createWorkflowStorage(): WorkflowStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

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
    const storage = createWorkflowStorage();
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
    const recorded = saveWorkflow(null, plan, storage);
    expect(recorded.workflow.id).toBe('user.workflows.save-workflow-test');

    const loaded = loadWorkflow(null, recorded.workflow.id, storage);
    expect(loaded).toBeDefined();
    expect(loaded!.workflow.id).toBe(recorded.workflow.id);
    expect(loaded!.originalPlan.planId).toBe(plan.planId);

    const all = listWorkflows(null, storage);
    expect(all.some((wf) => wf.workflow.id === recorded.workflow.id)).toBe(true);

    deleteWorkflow(null, recorded.workflow.id, storage);
    expect(loadWorkflow(null, recorded.workflow.id, storage)).toBeUndefined();
  });

  it('keeps an index-only failed write invisible to readers', () => {
    const values = new Map<string, string>();
    const storage: WorkflowStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (key.startsWith('joy-media.workflow.v1:user.workflows.')) {
          throw new Error('simulated final workflow write failure');
        }
        values.set(key, value);
      },
      removeItem: (key) => values.delete(key),
    };
    const plan = createPlan('Fail safely', []);

    expect(() => saveWorkflow(null, plan, storage)).toThrow(
      'simulated final workflow write failure',
    );
    expect(listWorkflows(null, storage)).toEqual([]);
  });

  it('parameterizes timing and structural identifiers while baking assetId and compositionId', () => {
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
    const plan = createPlan('Parameterization test', [step]);
    const workflow = convertPlanToWorkflow(plan);
    const node = workflow.nodes[0];
    expect(node).toBeDefined();

    const commands = node!.params.commands as
      | Readonly<{ readonly tool: string; readonly arguments: Record<string, unknown> }[]>
      | undefined;
    expect(commands).toHaveLength(1);
    const args = commands![0]!.arguments;

    expect(args.compositionId).toBe('root');
    expect(args.trackId).toEqual({ __parameter: true, name: 'trackId' });
    expect(args.clip).toBeDefined();
    const clipArgs = args.clip as Record<string, unknown>;
    expect(clipArgs.kind).toBe('video');
    expect(clipArgs.assetId).toBe('asset-agent-clip-1');
    expect(clipArgs.id).toEqual({ __parameter: true, name: 'clipId' });
    expect(clipArgs.startUs).toEqual({ __parameter: true, name: 'clipStartUs' });
    expect(clipArgs.durationUs).toEqual({ __parameter: true, name: 'clipDurationUs' });
    expect(clipArgs.sourceInUs).toEqual({ __parameter: true, name: 'clipSourceInUs' });

    const inputsProps = workflow.inputs.properties as Record<string, unknown>;
    expect(inputsProps.trackId).toBeDefined();
    expect(inputsProps.clipId).toBeDefined();
    expect(inputsProps.clipStartUs).toBeDefined();
    expect(inputsProps.clipDurationUs).toBeDefined();
    expect(inputsProps.clipSourceInUs).toBeDefined();
    expect(inputsProps.compositionId).toBeUndefined();
    expect(inputsProps.assetId).toBeUndefined();
  });

  it('resolveParameterizedValue substitutes parameters and leaves constants alone', () => {
    const marker = { __parameter: true, name: 'trackId' } as const;
    const value = {
      compositionId: 'root',
      trackId: marker,
      clip: {
        id: marker,
        startUs: { __parameter: true, name: 'clipStartUs' } as const,
        durationUs: 5_000_000,
      },
    };
    const inputs = { trackId: 'track-1', clipStartUs: 10_000_000 };
    const resolved = resolveParameterizedValue(value, inputs);
    expect((resolved as Record<string, unknown>).compositionId).toBe('root');
    expect((resolved as Record<string, unknown>).trackId).toBe('track-1');
    expect((resolved as Record<string, unknown>).clip).toBeDefined();
    const clip = (resolved as Record<string, unknown>).clip as Record<string, unknown>;
    expect(clip.id).toBe('track-1');
    expect(clip.startUs).toBe(10_000_000);
    expect(clip.durationUs).toBe(5_000_000);
  });
});
