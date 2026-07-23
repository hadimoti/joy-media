import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject, emptySpikeProject, makeVideoClip, SECOND_US } from '@joy-media/test-fixtures';
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

    const baseClip = makeVideoClip('agent-clip-1', 30 * SECOND_US, 5 * SECOND_US);
    const step: AgentPlanStep = {
      id: 'step-1',
      description: 'Insert a clip at the end of track-0',
      mode: 'command',
      tool: 'insertClip',
      arguments: {
        compositionId: 'root',
        trackId: 'track-0',
        clip: { ...baseClip },
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

    await runWorkflow(session, recorded.workflow.id, {
      trackId: 'track-0',
      clipId: baseClip.id,
      clipStartUs: baseClip.startUs,
      clipDurationUs: baseClip.durationUs,
      clipSourceInUs: baseClip.sourceInUs,
    });

    const afterClips = session.timelineProject.compositions.root?.tracks
      .find((t) => t.id === 'track-0')
      ?.clips.map((c) => c.id) ?? [];

    expect(afterClips).toEqual([...beforeClips, 'agent-clip-1']);
  });

  it('re-uses a recorded workflow on a different clip when inputs are overridden', async () => {
    const storage = new Map<string, string>();
    const project = emptySpikeProject({ trackCount: 1, durationUs: 30_000_000 });
    const session = new EditorSession(
      {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      project,
      INITIAL_EDITOR_PROJECT,
    );

    const clipA = makeVideoClip('clip-a', 0, 5 * SECOND_US);
    const step: AgentPlanStep = {
      id: 'step-1',
      description: 'Insert a clip',
      mode: 'command',
      tool: 'insertClip',
      arguments: {
        compositionId: 'root',
        trackId: 'track-0',
        clip: { ...clipA },
      },
      dependsOn: [],
      expectedChange: 'Insert clip-a',
      preconditions: [],
      requiresConfirmation: false,
    };
    const plan = createPlan('Re-use workflow on different clip', [step]);
    const recorded = saveWorkflow(session, plan);

    const beforeClips = session.timelineProject.compositions.root?.tracks
      .find((t) => t.id === 'track-0')
      ?.clips.map((c) => c.id) ?? [];

    await runWorkflow(session, recorded.workflow.id, {
      trackId: 'track-0',
      clipId: clipA.id,
      clipStartUs: clipA.startUs,
      clipDurationUs: clipA.durationUs,
      clipSourceInUs: clipA.sourceInUs,
    });

    const afterClipA = session.timelineProject.compositions.root?.tracks
      .find((t) => t.id === 'track-0')
      ?.clips.map((c) => c.id) ?? [];
    expect(afterClipA).toEqual([...beforeClips, 'clip-a']);

    session.undo();
    expect(
      session.timelineProject.compositions.root?.tracks
        .find((t) => t.id === 'track-0')
        ?.clips.map((c) => c.id) ?? [],
    ).toEqual(beforeClips);

    const clipB = makeVideoClip('clip-b', 0, 5 * SECOND_US);
    await runWorkflow(session, recorded.workflow.id, {
      trackId: 'track-0',
      clipId: clipB.id,
      clipStartUs: clipB.startUs,
      clipDurationUs: clipB.durationUs,
      clipSourceInUs: clipB.sourceInUs,
    });

    const afterClipB = session.timelineProject.compositions.root?.tracks
      .find((t) => t.id === 'track-0')
      ?.clips.map((c) => c.id) ?? [];
    expect(afterClipB).toEqual([...beforeClips, 'clip-b']);
  });
});
