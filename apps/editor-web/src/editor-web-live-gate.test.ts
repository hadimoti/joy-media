import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject, makeVideoClip, SECOND_US } from '@joy-media/test-fixtures';
import {
  ApprovalEngine,
  buildEditorContext,
  createPermissiveApprovalPolicy,
  createPlan,
  createToolRegistry,
  dryRunPlan,
  PlanExecutor,
  type AgentPlanStep,
} from '@joy-media/agent-tools';
import { createAgentCommandBus } from './agent-command-bus.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession } from './editor-session.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function clipIdsOf(session: EditorSession, trackId: string): readonly string[] {
  return (
    session.timelineProject.compositions.root?.tracks
      .find((t) => t.id === trackId)
      ?.clips.map((c) => c.id) ?? []
  );
}

describe('WP-15 live gate: agent edit → history → undo/redo', () => {
  it('executes a real plan through the agent bus, shows history entries, and undoes/redoes as one named action', async () => {
    const storage = memoryStorage();
    const session = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const bus = createAgentCommandBus(session);
    const context = buildEditorContext(session.timelineProject, {}, bus);
    const registry = createToolRegistry();

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

    const dryRunResult = dryRunPlan(plan, registry, context);
    expect(dryRunResult.success).toBe(true);

    const approvalEngine = new ApprovalEngine(createPermissiveApprovalPolicy());
    const executor = new PlanExecutor(registry, approvalEngine);
    const beforeClips = clipIdsOf(session, 'track-0');
    const execResult = await executor.execute(plan, context, session.timelineProject);

    expect(execResult.success).toBe(true);
    const afterClips = clipIdsOf(session, 'track-0');
    expect(afterClips).toEqual([...beforeClips, 'agent-clip-1']);

    expect(session.canUndo).toBe(true);
    const historyBeforeUndo = session.historyEntries;
    const undoEntries = historyBeforeUndo.filter((e) => e.direction === 'undo');
    expect(undoEntries.length).toBeGreaterThan(0);
    const lastUndoEntry = undoEntries[undoEntries.length - 1];
    expect(lastUndoEntry).toBeDefined();
    expect(lastUndoEntry!.source).toBe('timeline');
    expect(lastUndoEntry!.label).toContain('agent-clip-1');

    session.undo();
    expect(clipIdsOf(session, 'track-0')).toEqual(beforeClips);
    expect(session.canRedo).toBe(true);

    const historyAfterUndo = session.historyEntries;
    const redoEntries = historyAfterUndo.filter((e) => e.direction === 'redo');
    expect(redoEntries.length).toBeGreaterThan(0);

    session.redo();
    expect(clipIdsOf(session, 'track-0')).toEqual(afterClips);
  });
});
