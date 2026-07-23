import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject, makeVideoClip, SECOND_US } from '@joy-media/test-fixtures';
import { createPlan, type AgentPlanStep } from '@joy-media/agent-tools';
import { runWorkflow } from './workflow-runner.js';
import { saveWorkflow } from './workflow-recorder.js';
import { EditorSession } from './editor-session.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';

describe('workflow-runner', () => {
  it('executes a recorded editor.commandTransaction workflow', async () => {
    const storage = new Map<string, string>();
    const session = new EditorSession(
      {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );

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
    const plan = createPlan('Run workflow test', [step]);
    const recorded = saveWorkflow(session, plan);

    const beforeClips = session.timelineProject.compositions.root?.tracks
      .find((t) => t.id === 'track-0')
      ?.clips.map((c) => c.id) ?? [];

    await runWorkflow(session, recorded.workflow.id);

    const afterClips = session.timelineProject.compositions.root?.tracks
      .find((t) => t.id === 'track-0')
      ?.clips.map((c) => c.id) ?? [];

    expect(afterClips).toEqual([...beforeClips, 'agent-clip-1']);
  });
});
