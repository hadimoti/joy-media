import { describe, expect, it } from 'vitest';
import {
  ApprovalEngine,
  analyseShortenIntro,
  buildEditorContext,
  createAutoApplyLowRiskPolicy,
  createToolRegistry,
  RevisionConflictError,
  runPlanAtomically,
} from '@joy-media/agent-tools';
import type { AgentEditPlan, AtomicRunResult, ProjectRevisionId } from '@joy-media/agent-tools';
import type { SpikeProject } from '@joy-media/project-schema';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { createAgentCommandBus } from './agent-command-bus.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession } from './editor-session.js';

const approvalEngine = () => new ApprovalEngine(createAutoApplyLowRiskPolicy());

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function run(
  session: EditorSession,
  plan: AgentEditPlan,
  baseProject: SpikeProject,
  baseRevision: ProjectRevisionId,
): AtomicRunResult {
  const bus = createAgentCommandBus(session);
  return runPlanAtomically(plan, {
    registry: createToolRegistry(),
    approvalEngine: approvalEngine(),
    actor: { type: 'agent', id: 'joy-agent-test' },
    projectId: baseProject.id,
    baseRevision,
    baseProject,
    contextFor: (project) => buildEditorContext(project),
    currentRevision: () => session.projectRevisionId,
    idempotency: session.agentIdempotency,
    commit: (transaction) => bus.dispatchTimeline(transaction.commands, transaction.label),
  });
}

function clips(session: EditorSession): readonly {
  readonly id: string;
  readonly startUs: number;
  readonly durationUs: number;
}[] {
  return (
    session.timelineProject.compositions.root?.tracks[0]?.clips.map((clip) => ({
      id: clip.id,
      startUs: clip.startUs,
      durationUs: clip.durationUs,
    })) ?? []
  );
}

describe('durable agent revision integration', () => {
  it('rejects a plan after an intervening edit to either persisted project slice, then replans', () => {
    const session = new EditorSession(
      memoryStorage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const baseProject = session.timelineProject;
    const baseRevision = session.projectRevisionId;
    const analysed = analyseShortenIntro(baseProject, { byUs: 2_000_000 });
    if (!analysed.ok) throw new Error(analysed.reason);

    // A document/Inspector edit also invalidates a timeline plan: the revision
    // identifies the complete creative document, not one isolated log.
    session.dispatchVisualObjects({
      label: 'Human moves title',
      commands: [
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'intro-title', key: 'x', value: 32 },
        },
      ],
    });

    expect(() => run(session, analysed.plan, baseProject, baseRevision)).toThrow(
      RevisionConflictError,
    );
    expect(clips(session)[0]).toMatchObject({ id: 'intro', durationUs: 10_000_000 });

    const replanned = analyseShortenIntro(session.timelineProject, { byUs: 2_000_000 });
    if (!replanned.ok) throw new Error(replanned.reason);
    const result = run(session, replanned.plan, session.timelineProject, session.projectRevisionId);
    expect(result.committed).toBe(true);
    expect(clips(session)[0]).toMatchObject({ id: 'intro', durationUs: 8_000_000 });
  });

  it('recovers the revision and idempotency receipt so the same retry is a no-op', () => {
    const storage = memoryStorage();
    const first = new EditorSession(storage, buildReferenceSpikeProject(), INITIAL_EDITOR_PROJECT);
    const baseProject = first.timelineProject;
    const baseRevision = first.projectRevisionId;
    const analysed = analyseShortenIntro(baseProject, { byUs: 2_000_000 });
    if (!analysed.ok) throw new Error(analysed.reason);

    const applied = run(first, analysed.plan, baseProject, baseRevision);
    expect(applied.committed).toBe(true);
    const appliedRevision = first.projectRevisionId;
    const appliedClips = clips(first);

    const reopened = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    expect(reopened.projectRevisionId).toBe(appliedRevision);

    // The original base revision is now stale. Idempotency wins first because
    // this exact logical run already committed; a retry is successful and does
    // not need to replan or apply commands again.
    const replay = run(reopened, analysed.plan, baseProject, baseRevision);
    expect(replay.replayed).toBe(true);
    expect(replay.committed).toBe(false);
    expect(replay.errors).toEqual([]);
    expect(replay.commands).toEqual([]);
    expect(reopened.projectRevisionId).toBe(appliedRevision);
    expect(clips(reopened)).toEqual(appliedClips);
    expect(reopened.canUndo).toBe(false);
  });

  it('leaves the durable project and revision unchanged when staging fails', () => {
    const session = new EditorSession(
      memoryStorage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const beforeProject = structuredClone(session.timelineProject);
    const beforeRevision = session.projectRevisionId;
    const analysed = analyseShortenIntro(session.timelineProject, { byUs: 2_000_000 });
    if (!analysed.ok) throw new Error(analysed.reason);
    const broken: AgentEditPlan = {
      ...analysed.plan,
      steps: [
        analysed.plan.steps[0]!,
        analysed.plan.steps[1]!,
        {
          ...analysed.plan.steps[2]!,
          arguments: {
            ...(analysed.plan.steps[2]!.arguments as object),
            clipId: 'missing-clip',
          },
        },
      ],
    };

    const result = run(session, broken, session.timelineProject, beforeRevision);
    expect(result.committed).toBe(false);
    expect(result.replayed).toBe(false);
    expect(session.timelineProject).toEqual(beforeProject);
    expect(session.projectRevisionId).toBe(beforeRevision);
    expect(session.canUndo).toBe(false);
  });

  it('runs and reverts as one undo step in a session reopened from durable state', () => {
    const storage = memoryStorage();
    const first = new EditorSession(storage, buildReferenceSpikeProject(), INITIAL_EDITOR_PROJECT);
    first.dispatchTimeline({
      label: 'Human trims B-roll',
      commands: [
        {
          type: 'timeline.trimClipEnd',
          payload: {
            compositionId: 'root',
            trackId: 'track-1',
            clipId: 'b-roll-a',
            newEndUs: 14_000_000,
          },
        },
      ],
    });

    const reopened = new EditorSession(
      storage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const before = clips(reopened);
    const analysed = analyseShortenIntro(reopened.timelineProject, { byUs: 2_000_000 });
    if (!analysed.ok) throw new Error(analysed.reason);
    const applied = run(
      reopened,
      analysed.plan,
      reopened.timelineProject,
      reopened.projectRevisionId,
    );

    expect(applied.committed).toBe(true);
    expect(reopened.canUndo).toBe(true);
    reopened.undo();
    expect(clips(reopened)).toEqual(before);
    expect(reopened.canUndo).toBe(false);
  });
});
