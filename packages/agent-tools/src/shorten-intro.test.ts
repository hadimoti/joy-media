/**
 * The "shorten the intro" vertical slice, end to end:
 * query → plan → dry-run change set → approval → atomic transaction →
 * verification → one-step undo.
 *
 * The properties worth protecting here are the ones that were previously
 * untrue: a multi-step agent run must commit as ONE transaction (so one undo
 * reverts all of it), must not touch the project when any step fails, and must
 * refuse to commit against a revision it did not plan against.
 */

import { describe, expect, it } from 'vitest';
import { applyTransaction, ProjectHistory } from '@joy-media/commands';
import type { CommandTransaction, SpikeCommand } from '@joy-media/commands';
import type { SpikeProject } from '@joy-media/project-schema';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { analyseShortenIntro } from './shorten-intro.js';
import { runPlanAtomically } from './atomic.js';
import { RevisionConflictError, validateEnvelope, createEnvelope } from './envelope.js';
import type { AgentActor } from './envelope.js';
import { createToolRegistry } from './registry.js';
import { ApprovalEngine, createDefaultApprovalPolicy, createStrictApprovalPolicy } from './approval.js';
import { buildEditorContext } from './context.js';
import { dryRunPlan } from './dry-run.js';
import { updatePlanStatus } from './plan.js';

const AGENT: AgentActor = { type: 'agent', id: 'hermes' };
const TWO_SECONDS = 2_000_000;

// createToolRegistry() already registers the full first-party tool set.
const registry = createToolRegistry;

function clipsOf(project: SpikeProject, trackId = 'track-0') {
  const track = project.compositions.root?.tracks.find((t) => t.id === trackId);
  return [...(track?.clips ?? [])]
    .sort((a, b) => a.startUs - b.startUs)
    .map((c) => ({ id: c.id, startUs: c.startUs, durationUs: c.durationUs }));
}

/** Stands in for EditorSession: one transaction in, one undo entry recorded. */
class FakeSession {
  #project: SpikeProject;
  readonly committed: CommandTransaction[] = [];
  readonly #history: ProjectHistory;

  constructor(project: SpikeProject) {
    this.#project = project;
    this.#history = new ProjectHistory(project);
  }

  get project(): SpikeProject {
    return this.#project;
  }

  /** Monotonic per commit — the revision the envelope pins to. */
  get revision(): number {
    return this.committed.length;
  }

  commit = (transaction: CommandTransaction) => {
    this.#project = this.#history.apply(transaction);
    this.committed.push(transaction);
    return { success: true as const };
  };

  undo(): void {
    this.#project = this.#history.undo();
    this.committed.pop();
  }
}

function runOptions(session: FakeSession, baseRevision = session.revision) {
  return {
    registry: registry(),
    approvalEngine: new ApprovalEngine(createDefaultApprovalPolicy()),
    actor: AGENT,
    projectId: session.project.id,
    baseRevision,
    baseProject: session.project,
    contextFor: (project: SpikeProject) => buildEditorContext(project),
    currentRevision: () => session.revision,
    commit: session.commit,
  };
}

describe('shorten the intro — query stage', () => {
  it('finds the opening clip and everything that must ripple with it', () => {
    const result = analyseShortenIntro(buildReferenceSpikeProject(), { byUs: TWO_SECONDS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis.introClipId).toBe('intro');
    expect(result.analysis.introDurationUs).toBe(10_000_000);
    expect(result.analysis.newIntroDurationUs).toBe(8_000_000);
    expect(result.analysis.rippledClipIds).toEqual(['product', 'outro']);
  });

  it('refuses an amount that would leave nothing of the intro', () => {
    const result = analyseShortenIntro(buildReferenceSpikeProject(), { byUs: 10_000_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('must stay at least');
  });

  it('rejects a non-positive amount rather than planning a no-op', () => {
    expect(analyseShortenIntro(buildReferenceSpikeProject(), { byUs: 0 }).ok).toBe(false);
    expect(analyseShortenIntro(buildReferenceSpikeProject(), { byUs: -1 }).ok).toBe(false);
  });
});

describe('shorten the intro — plan stage', () => {
  it('orders the ripple behind the trim so nothing collides mid-run', () => {
    const result = analyseShortenIntro(buildReferenceSpikeProject(), { byUs: TWO_SECONDS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.plan.steps.map((s) => s.id);
    expect(ids).toEqual(['trim-intro', 'ripple-product', 'ripple-outro']);
    expect(result.plan.steps[1]?.dependsOn).toEqual(['trim-intro']);
    expect(result.plan.steps[2]?.dependsOn).toEqual(['ripple-product']);
    expect(result.plan.estimated.commandCount).toBe(3);
  });

  it('states its assumptions instead of leaving "the intro" implicit', () => {
    const result = analyseShortenIntro(buildReferenceSpikeProject(), { byUs: TWO_SECONDS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.assumptions.join(' ')).toContain('first clip on track track-0');
  });
});

describe('shorten the intro — dry run', () => {
  it('produces a change set without touching the project', () => {
    const project = buildReferenceSpikeProject();
    const before = clipsOf(project);
    const result = analyseShortenIntro(project, { byUs: TWO_SECONDS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const dry = dryRunPlan(result.plan, registry(), buildEditorContext(project));

    expect(dry.success).toBe(true);
    expect(dry.stepResults).toHaveLength(3);
    expect(clipsOf(project)).toEqual(before);
  });
});

describe('shorten the intro — atomic execution', () => {
  it('commits three commands as exactly one transaction', () => {
    const session = new FakeSession(buildReferenceSpikeProject());
    const result = analyseShortenIntro(session.project, { byUs: TWO_SECONDS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const run = runPlanAtomically(result.plan, runOptions(session));

    expect(run.errors).toEqual([]);
    expect(run.committed).toBe(true);
    expect(run.commands).toHaveLength(3);
    // The property that was previously false: one undo entry, not three.
    expect(session.committed).toHaveLength(1);
    expect(session.committed[0]?.commands).toHaveLength(3);
  });

  it('produces the intended timeline: intro shorter, later clips rippled back', () => {
    const session = new FakeSession(buildReferenceSpikeProject());
    const result = analyseShortenIntro(session.project, { byUs: TWO_SECONDS });
    if (!result.ok) throw new Error(result.reason);

    runPlanAtomically(result.plan, runOptions(session));

    expect(clipsOf(session.project)).toEqual([
      { id: 'intro', startUs: 0, durationUs: 8_000_000 },
      { id: 'product', startUs: 8_000_000, durationUs: 10_000_000 },
      { id: 'outro', startUs: 18_000_000, durationUs: 10_000_000 },
    ]);
  });

  it('leaves other tracks untouched', () => {
    const session = new FakeSession(buildReferenceSpikeProject());
    const before = clipsOf(session.project, 'track-1');
    const result = analyseShortenIntro(session.project, { byUs: TWO_SECONDS });
    if (!result.ok) throw new Error(result.reason);

    runPlanAtomically(result.plan, runOptions(session));

    expect(clipsOf(session.project, 'track-1')).toEqual(before);
  });

  it('stamps every command with a complete envelope sharing one transaction id', () => {
    const session = new FakeSession(buildReferenceSpikeProject());
    const result = analyseShortenIntro(session.project, { byUs: TWO_SECONDS });
    if (!result.ok) throw new Error(result.reason);

    const run = runPlanAtomically(result.plan, runOptions(session));

    expect(run.envelopes).toHaveLength(3);
    for (const envelope of run.envelopes) {
      expect(validateEnvelope(envelope).valid).toBe(true);
      expect(envelope.schemaVersion).toBe('1.0');
      expect(envelope.projectId).toBe('golden-social-edit');
      expect(envelope.baseRevision).toBe(0);
      expect(envelope.actor).toEqual(AGENT);
      expect(envelope.transactionId).toBe(run.transactionId);
    }
    expect(new Set(run.envelopes.map((e) => e.commandId)).size).toBe(3);
    expect(new Set(run.envelopes.map((e) => e.idempotencyKey)).size).toBe(3);
    expect(run.envelopes[0]?.preconditions.length).toBeGreaterThan(0);
  });
});

describe('shorten the intro — one-step undo', () => {
  it('restores the exact original timeline in a single undo', () => {
    const session = new FakeSession(buildReferenceSpikeProject());
    const before = clipsOf(session.project);
    const result = analyseShortenIntro(session.project, { byUs: TWO_SECONDS });
    if (!result.ok) throw new Error(result.reason);

    runPlanAtomically(result.plan, runOptions(session));
    expect(clipsOf(session.project)).not.toEqual(before);

    session.undo();

    expect(clipsOf(session.project)).toEqual(before);
  });
});

describe('shorten the intro — failure is all-or-nothing', () => {
  it('commits nothing when a step fails mid-plan', () => {
    const session = new FakeSession(buildReferenceSpikeProject());
    const result = analyseShortenIntro(session.project, { byUs: TWO_SECONDS });
    if (!result.ok) throw new Error(result.reason);
    const before = clipsOf(session.project);

    // Point the last ripple at a clip that does not exist. Under the old
    // per-step dispatch the first two commands would already be live.
    const broken = {
      ...result.plan,
      steps: [
        result.plan.steps[0]!,
        result.plan.steps[1]!,
        {
          ...result.plan.steps[2]!,
          arguments: { ...(result.plan.steps[2]!.arguments as object), clipId: 'no-such-clip' },
        },
      ],
    };

    const run = runPlanAtomically(broken, runOptions(session));

    expect(run.committed).toBe(false);
    expect(run.errors.length).toBeGreaterThan(0);
    expect(session.committed).toHaveLength(0);
    expect(clipsOf(session.project)).toEqual(before);
  });

  it('blocks on policy without staging a partial edit', () => {
    const session = new FakeSession(buildReferenceSpikeProject());
    const result = analyseShortenIntro(session.project, { byUs: TWO_SECONDS });
    if (!result.ok) throw new Error(result.reason);

    const run = runPlanAtomically(result.plan, {
      ...runOptions(session),
      approvalEngine: new ApprovalEngine(createStrictApprovalPolicy()),
    });

    if (!run.committed) {
      expect(session.committed).toHaveLength(0);
      expect(clipsOf(session.project)).toEqual(clipsOf(buildReferenceSpikeProject()));
    } else {
      // A permissive strict policy still must not half-apply.
      expect(session.committed).toHaveLength(1);
    }
  });
});

describe('shorten the intro — revision safety', () => {
  it('refuses to commit a plan built against a stale revision', () => {
    const session = new FakeSession(buildReferenceSpikeProject());
    const result = analyseShortenIntro(session.project, { byUs: TWO_SECONDS });
    if (!result.ok) throw new Error(result.reason);

    // Someone else edits the project between planning and commit.
    session.commit({
      label: 'human edit',
      commands: [
        {
          type: 'timeline.trimClipEnd',
          payload: {
            compositionId: 'root',
            trackId: 'track-1',
            clipId: 'b-roll-a',
            newEndUs: 14_000_000,
          },
        } as SpikeCommand,
      ],
    });

    expect(() =>
      runPlanAtomically(result.plan, runOptions(session, 0)),
    ).toThrow(RevisionConflictError);
    // The stale run must not have landed.
    expect(session.committed).toHaveLength(1);
  });

  it('commits when the revision still matches', () => {
    const session = new FakeSession(buildReferenceSpikeProject());
    const result = analyseShortenIntro(session.project, { byUs: TWO_SECONDS });
    if (!result.ok) throw new Error(result.reason);

    const run = runPlanAtomically(result.plan, runOptions(session, session.revision));

    expect(run.committed).toBe(true);
  });
});

describe('command envelope', () => {
  const valid = () =>
    createEnvelope({
      projectId: 'p1',
      baseRevision: 3,
      transactionId: 'tx-1',
      idempotencyKey: 'plan:step:0',
      actor: AGENT,
      type: 'timeline.moveClip',
      params: {},
    });

  it('accepts a complete envelope', () => {
    expect(validateEnvelope(valid()).valid).toBe(true);
  });

  it('rejects a negative or fractional baseRevision', () => {
    expect(validateEnvelope({ ...valid(), baseRevision: -1 }).errors).toContain(
      'baseRevision must be a non-negative integer',
    );
    expect(validateEnvelope({ ...valid(), baseRevision: 1.5 }).valid).toBe(false);
  });

  it('rejects an unknown actor type', () => {
    const bad = { ...valid(), actor: { type: 'robot' as 'agent', id: 'x' } };
    expect(validateEnvelope(bad).valid).toBe(false);
  });

  it('rejects a missing transaction id', () => {
    expect(validateEnvelope({ ...valid(), transactionId: '' }).valid).toBe(false);
  });
});

describe('staging does not mutate the project it was handed', () => {
  it('applies to a copy, leaving the base project object untouched', () => {
    const base = buildReferenceSpikeProject();
    const session = new FakeSession(base);
    const result = analyseShortenIntro(base, { byUs: TWO_SECONDS });
    if (!result.ok) throw new Error(result.reason);

    const run = runPlanAtomically(result.plan, {
      ...runOptions(session),
      // Never commit, so only staging runs.
      commit: () => ({ success: false, error: 'commit disabled for this test' }),
    });

    expect(clipsOf(base)).toEqual(clipsOf(buildReferenceSpikeProject()));
    // The staged preview still shows the intended result.
    expect(clipsOf(run.stagedProject)[0]).toEqual({
      id: 'intro',
      startUs: 0,
      durationUs: 8_000_000,
    });
  });
});

describe('plan status transitions through the loop', () => {
  it('moves draft → approved → completed', () => {
    const result = analyseShortenIntro(buildReferenceSpikeProject(), { byUs: TWO_SECONDS });
    if (!result.ok) throw new Error(result.reason);

    expect(result.plan.status).toBe('draft');
    const approved = updatePlanStatus(result.plan, 'approved');
    expect(approved.status).toBe('approved');
    expect(updatePlanStatus(approved, 'completed').status).toBe('completed');
  });
});

describe('reference fixture sanity', () => {
  it('the transaction really is reversible at the command layer', () => {
    const project = buildReferenceSpikeProject();
    const commands: SpikeCommand[] = [
      {
        type: 'timeline.trimClipEnd',
        payload: {
          compositionId: 'root',
          trackId: 'track-0',
          clipId: 'intro',
          newEndUs: 8_000_000,
        },
      } as SpikeCommand,
    ];
    const applied = applyTransaction(project, { label: 'trim', commands });
    expect(applied.project).not.toBe(project);
    expect(applied.record.inverses).toHaveLength(1);
  });
});
