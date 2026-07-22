import { describe, expect, it } from 'vitest';
import { ProjectHistory } from '@joy-media/commands';
import type { CommandTransaction } from '@joy-media/commands';
import type { SpikeProject } from '@joy-media/project-schema';
import { emptySpikeProject, makeVideoClip, SECOND_US, withClips } from '@joy-media/test-fixtures';
import {
  createInsertClipTool,
  createJoinClipsTool,
  createMoveClipTool,
  createRemoveClipTool,
  createSplitClipTool,
  createTrimClipTool,
} from './edit-tools.js';
import type { CommandDispatchResult, CommandDispatcher, EditorContext } from './context.js';
import {
  createPlan,
  createToolRegistry,
  PlanExecutor,
  ApprovalEngine,
  createPermissiveApprovalPolicy,
} from './index.js';
import type { AgentPlanStep } from './plan.js';

/**
 * WP-15.1: proves `EditTool.execute` really dispatches through the same
 * command bus the human editor uses (`@joy-media/commands`' `ProjectHistory`)
 * rather than fabricating a diff — the exact gap the 2026-07-22 P06 audit
 * found (`@joy-media/agent-tools` complete but never reaching a real
 * project). No editor-web/browser claim is made here; that bridge is
 * `apps/editor-web/src/agent-command-bus.ts`, proven by its own test.
 */

function baseProject(): SpikeProject {
  return withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
    makeVideoClip('clip-a', 0, 2 * SECOND_US),
    makeVideoClip('clip-b', 3 * SECOND_US, 2 * SECOND_US),
  ]);
}

/** Real dispatcher: applies through a real `ProjectHistory`, exactly like `EditorSession.dispatchTimeline`. */
function realDispatcher(history: ProjectHistory): CommandDispatcher {
  return {
    dispatchTimeline(commands, label): CommandDispatchResult {
      try {
        history.apply({ label, commands } satisfies CommandTransaction);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  };
}

function contextWith(dispatch: CommandDispatcher | undefined): EditorContext {
  return {
    project: {
      id: 'spike-project',
      name: 'Spike Project',
      durationUs: 60 * SECOND_US,
      compositionCount: 1,
      trackCount: 1,
      clipCount: 2,
      hasCaptions: false,
      hasAudio: false,
      missingAssets: [],
    },
    selection: { selectedClipIds: [], selectedTrackIds: [], playheadUs: 0 },
    timeline: { compositions: [], totalDurationUs: 60 * SECOND_US },
    audio: { clipCount: 0, busCount: 0, hasDialogue: false },
    providers: { availableProviders: [], localOnly: true },
    availableTools: [],
    recentHistory: [],
    constraints: [],
    ...(dispatch && { dispatch }),
  };
}

function clipIdsOf(project: SpikeProject): readonly string[] {
  return project.compositions['root']!.tracks[0]!.clips.map((c) => c.id);
}

describe('WP-15.1 real command-bus dispatch', () => {
  it('insertClip really mutates the bound project, not just a fabricated diff', () => {
    const history = new ProjectHistory(baseProject());
    const context = contextWith(realDispatcher(history));
    const tool = createInsertClipTool();

    const result = tool.execute(context, {
      compositionId: 'root',
      trackId: 'track-0',
      clip: { ...makeVideoClip('clip-c', 2 * SECOND_US, SECOND_US) },
    });

    expect(result.success).toBe(true);
    expect(clipIdsOf(history.present)).toEqual(['clip-a', 'clip-c', 'clip-b']);

    // The mutation is a real, undoable transaction — not a side-effect-free preview.
    expect(history.canUndo).toBe(true);
    history.undo();
    expect(clipIdsOf(history.present)).toEqual(['clip-a', 'clip-b']);
  });

  it('surfaces the real command validation failure instead of pretending success', () => {
    const history = new ProjectHistory(baseProject());
    const context = contextWith(realDispatcher(history));
    const tool = createInsertClipTool();

    // Overlaps clip-a — the naive shape-only precondition check can't catch this;
    // only the real `applyCommand` validation does.
    const result = tool.execute(context, {
      compositionId: 'root',
      trackId: 'track-0',
      clip: { ...makeVideoClip('clip-overlap', 0, SECOND_US) },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/overlaps/);
    // Rejected transaction must leave the real project untouched.
    expect(clipIdsOf(history.present)).toEqual(['clip-a', 'clip-b']);
    expect(history.canUndo).toBe(false);
  });

  it('removeClip really mutates and undo restores the exact prior state', () => {
    const history = new ProjectHistory(baseProject());
    const context = contextWith(realDispatcher(history));
    const tool = createRemoveClipTool();

    const before = history.present;
    const result = tool.execute(context, {
      compositionId: 'root',
      trackId: 'track-0',
      clipId: 'clip-a',
    });

    expect(result.success).toBe(true);
    expect(clipIdsOf(history.present)).toEqual(['clip-b']);

    history.undo();
    expect(history.present).toEqual(before);
  });

  it('moveClip rejects a real overlap with the destination clip', () => {
    const history = new ProjectHistory(baseProject());
    const context = contextWith(realDispatcher(history));
    const tool = createMoveClipTool();

    const result = tool.execute(context, {
      compositionId: 'root',
      trackId: 'track-0',
      clipId: 'clip-a',
      newStartUs: 3 * SECOND_US, // lands inside clip-b's range
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/overlaps/);
  });

  it('trimClip with both boundaries dispatches one atomic two-command transaction', () => {
    const history = new ProjectHistory(baseProject());
    const context = contextWith(realDispatcher(history));
    const tool = createTrimClipTool();

    const result = tool.execute(context, {
      compositionId: 'root',
      trackId: 'track-0',
      clipId: 'clip-a',
      newStartUs: 500_000,
      newEndUs: 1_500_000,
    });

    expect(result.success).toBe(true);
    const clipA = history.present.compositions['root']!.tracks[0]!.clips.find(
      (c) => c.id === 'clip-a',
    )!;
    expect(clipA.startUs).toBe(500_000);
    expect(clipA.durationUs).toBe(1_000_000);

    // One undo reverts both boundary changes together (one agent transaction).
    history.undo();
    const restored = history.present.compositions['root']!.tracks[0]!.clips.find(
      (c) => c.id === 'clip-a',
    )!;
    expect(restored.startUs).toBe(0);
    expect(restored.durationUs).toBe(2 * SECOND_US);
  });

  it('splitClip then joinClips round-trips through the real command bus', () => {
    const history = new ProjectHistory(baseProject());
    const context = contextWith(realDispatcher(history));
    const split = createSplitClipTool();
    const join = createJoinClipsTool();

    const splitResult = split.execute(context, {
      compositionId: 'root',
      trackId: 'track-0',
      clipId: 'clip-a',
      atUs: SECOND_US,
      newClipId: 'clip-a-2',
    });
    expect(splitResult.success).toBe(true);
    expect(clipIdsOf(history.present)).toEqual(['clip-a', 'clip-a-2', 'clip-b']);

    const joinResult = join.execute(context, {
      compositionId: 'root',
      trackId: 'track-0',
      firstClipId: 'clip-a',
      secondClipId: 'clip-a-2',
    });
    expect(joinResult.success).toBe(true);
    expect(clipIdsOf(history.present)).toEqual(['clip-a', 'clip-b']);
  });

  it('falls back to the historical preview result when no command bus is bound', () => {
    const context = contextWith(undefined);
    const tool = createInsertClipTool();

    const result = tool.execute(context, {
      compositionId: 'comp-1',
      trackId: 'track-1',
      clip: { id: 'clip-preview' },
    });

    // Same shape planning/estimation callers have always seen: a preview
    // diff with no project to check it against.
    expect(result.success).toBe(true);
    expect(result.diff?.created).toContain('clip-preview');
  });

  it('a full agent plan really mutates the bound project end to end, and a failed step leaves it untouched', async () => {
    const history = new ProjectHistory(baseProject());
    const context = contextWith(realDispatcher(history));
    const registry = createToolRegistry();
    const approvalEngine = new ApprovalEngine(createPermissiveApprovalPolicy());
    const executor = new PlanExecutor(registry, approvalEngine);

    const goodStep: AgentPlanStep = {
      id: 'step-1',
      description: 'Insert a bridging clip',
      mode: 'command',
      tool: 'insertClip',
      arguments: {
        compositionId: 'root',
        trackId: 'track-0',
        clip: { ...makeVideoClip('clip-bridge', 2 * SECOND_US, SECOND_US) },
      },
      dependsOn: [],
      expectedChange: 'Insert clip-bridge',
      preconditions: [],
      requiresConfirmation: false,
    };
    const goodPlan = createPlan('Bridge the gap', [goodStep]);
    const goodResult = await executor.execute(goodPlan, context, {});

    expect(goodResult.success).toBe(true);
    expect(clipIdsOf(history.present)).toEqual(['clip-a', 'clip-bridge', 'clip-b']);

    const before = history.present;
    const badStep: AgentPlanStep = {
      ...goodStep,
      id: 'step-2',
      arguments: {
        compositionId: 'root',
        trackId: 'track-0',
        clip: { ...makeVideoClip('clip-dup', 0, SECOND_US) }, // overlaps clip-a
      },
      expectedChange: 'Insert clip-dup',
    };
    const badPlan = createPlan('Insert an overlapping clip', [badStep]);
    const badResult = await executor.execute(badPlan, context, {});

    expect(badResult.success).toBe(false);
    expect(history.present).toEqual(before);
  });
});
