/**
 * Atomic plan execution: stage every step against a scratch project, verify the
 * result, then commit the whole run as ONE transaction.
 *
 * `PlanExecutor.execute` dispatches each step through `context.dispatch` as it
 * goes, so an N-step plan lands as N separate entries on the editor's undo
 * stack. That breaks the property the agentic architecture actually needs:
 * "one Undo should revert the entire transaction". It also means a plan that
 * fails at step 3 leaves steps 1–2 applied, with no way back except manual
 * undo — the project is left in a state the agent never intended.
 *
 * So this module runs the plan against a *staged* copy. Each step sees the
 * results of the steps before it (via a context rebuilt on the staged project,
 * which is what makes dependent steps like split→trim correct), but nothing
 * touches the real project until every step has succeeded and verification has
 * passed. Commit is a single `CommandTransaction`, so it is a single undo.
 *
 * `BranchManager` records these runs; it stores snapshots but does not produce
 * them, which is the job this module does.
 */

import { applyTransaction, CommandError } from '@joy-media/commands';
import type { CommandTransaction, SpikeCommand } from '@joy-media/commands';
import type { SpikeProject } from '@joy-media/project-schema';
import type { EditorContext, CommandDispatchResult } from './context.js';
import type { ToolRegistry } from './registry.js';
import type { ApprovalEngine } from './approval.js';
import type { AgentEditPlan } from './plan.js';
import { resolveExecutionOrder } from './execution-order.js';
import { generateTransactionLabel } from './transaction-naming.js';
import { createEnvelope, checkBaseRevision } from './envelope.js';
import type { AgentActor, AgentCommandEnvelope, ProjectRevisionId } from './envelope.js';
import type { IdempotencyTracker } from './idempotency.js';

export interface AtomicRunOptions {
  readonly registry: ToolRegistry;
  readonly approvalEngine: ApprovalEngine;
  readonly actor: AgentActor;
  readonly projectId: string;
  /** Revision the plan was built against. */
  readonly baseRevision: ProjectRevisionId;
  /** The project as of `baseRevision`; staged edits start here. */
  readonly baseProject: SpikeProject;
  /** Rebuilds a tool-facing context for a staged project. */
  readonly contextFor: (project: SpikeProject) => EditorContext;
  /**
   * Read lazily and compared to `baseRevision` immediately before commit, so a
   * project that moved on during planning is caught rather than overwritten.
   */
  readonly currentRevision: () => ProjectRevisionId;
  /** Applies the accumulated commands as one transaction. */
  readonly commit: (transaction: CommandTransaction) => CommandDispatchResult;
  /**
   * Durable run-level receipt. A retry with the same key is a successful no-op,
   * even after reload and even though the project revision has advanced.
   */
  readonly idempotency?: IdempotencyTracker;
  readonly idempotencyKey?: string;
  readonly transactionLabel?: string;
  /** Created by the trusted UI only after the user approves this pending plan. */
  readonly manualApproval?: AtomicApprovalGrant;
}

export interface AtomicApprovalGrant {
  readonly planId: string;
  readonly approvedAt: string;
}

export interface AtomicStepOutcome {
  readonly stepId: string;
  readonly status: 'staged' | 'failed' | 'blocked-by-policy';
  readonly envelopes: readonly AgentCommandEnvelope[];
  readonly error?: string;
}

export interface AtomicRunResult {
  readonly planId: string;
  readonly transactionId: string;
  readonly committed: boolean;
  readonly replayed: boolean;
  readonly idempotencyKey: string;
  readonly transactionLabel: string;
  readonly steps: readonly AtomicStepOutcome[];
  /** Every command the run would apply, in order. Empty when nothing staged. */
  readonly commands: readonly SpikeCommand[];
  readonly envelopes: readonly AgentCommandEnvelope[];
  /** The staged project. Present even when `committed` is false, for preview. */
  readonly stagedProject: SpikeProject;
  readonly baseRevision: ProjectRevisionId;
  readonly errors: readonly string[];
}

let transactionCounter = 0;

/**
 * Collects commands instead of dispatching them, applying each to a running
 * staged project so the next step observes the previous step's effect.
 */
class StagingDispatcher {
  #project: SpikeProject;
  readonly #commands: SpikeCommand[] = [];

  constructor(base: SpikeProject) {
    this.#project = base;
  }

  get project(): SpikeProject {
    return this.#project;
  }

  get commands(): readonly SpikeCommand[] {
    return this.#commands;
  }

  dispatchTimeline(commands: readonly SpikeCommand[], _label: string): CommandDispatchResult {
    try {
      // Applied one transaction at a time so a step that fails validation
      // reports its own error and leaves the staged project untouched.
      const result = applyTransaction(this.#project, { label: _label, commands: [...commands] });
      this.#project = result.project;
      this.#commands.push(...commands);
      return { success: true };
    } catch (error) {
      if (error instanceof CommandError) {
        return { success: false, error: `${error.code}: ${error.message}` };
      }
      throw error;
    }
  }
}

export function runPlanAtomically(plan: AgentEditPlan, options: AtomicRunOptions): AtomicRunResult {
  const transactionId = `tx-${++transactionCounter}-${Date.now()}`;
  const transactionLabel = options.transactionLabel ?? generateTransactionLabel(plan);
  const idempotencyKey = options.idempotencyKey ?? `agent-plan:${plan.planId}`;
  const steps: AtomicStepOutcome[] = [];
  const envelopes: AgentCommandEnvelope[] = [];
  const errors: string[] = [];

  if (options.idempotency?.hasExecuted(idempotencyKey) === true) {
    return {
      planId: plan.planId,
      transactionId,
      committed: false,
      replayed: true,
      idempotencyKey,
      transactionLabel,
      steps: [],
      commands: [],
      envelopes: [],
      stagedProject: options.baseProject,
      baseRevision: options.baseRevision,
      errors: [],
    };
  }

  const order = resolveExecutionOrder(plan);
  if (order.hasCycle) {
    return {
      planId: plan.planId,
      transactionId,
      committed: false,
      replayed: false,
      idempotencyKey,
      transactionLabel,
      steps: [],
      commands: [],
      envelopes: [],
      stagedProject: options.baseProject,
      baseRevision: options.baseRevision,
      errors: ['plan contains circular dependencies'],
    };
  }

  const staging = new StagingDispatcher(options.baseProject);

  for (const stepId of order.order) {
    const step = plan.steps.find((s) => s.id === stepId);
    if (step === undefined) {
      errors.push(`step ${stepId} not found in plan`);
      break;
    }

    const tool = options.registry.getTool(step.tool);
    if (tool === undefined) {
      steps.push({ stepId, status: 'failed', envelopes: [], error: `tool ${step.tool} not found` });
      errors.push(`step ${stepId}: tool ${step.tool} not found`);
      break;
    }

    const toolScope = 'definition' in tool ? tool.definition.scope : undefined;
    const decision = options.approvalEngine.evaluateStep(
      step,
      options.contextFor(staging.project),
      toolScope,
    );
    if (
      decision.decision === 'blocked' ||
      (decision.decision === 'requires-manual' && options.manualApproval?.planId !== plan.planId)
    ) {
      steps.push({
        stepId,
        status: 'blocked-by-policy',
        envelopes: [],
        ...(decision.reason !== undefined ? { error: decision.reason } : {}),
      });
      errors.push(`step ${stepId} blocked by policy: ${decision.reason ?? 'no reason given'}`);
      break;
    }

    const before = staging.commands.length;
    // The context is rebuilt on the staged project each step, so a step that
    // depends on an earlier one sees the earlier one's result.
    const context: EditorContext = {
      ...options.contextFor(staging.project),
      dispatch: {
        dispatchTimeline: (commands, label) => staging.dispatchTimeline(commands, label),
      },
    };

    const result =
      'execute' in tool
        ? tool.execute(context, step.arguments)
        : { success: false, error: 'tool does not support execution' };

    if (!result.success) {
      steps.push({
        stepId,
        status: 'failed',
        envelopes: [],
        error: result.error ?? 'unknown tool failure',
      });
      errors.push(`step ${stepId} failed: ${result.error ?? 'unknown tool failure'}`);
      break;
    }

    const stepEnvelopes = staging.commands.slice(before).map((command, index) =>
      createEnvelope({
        projectId: options.projectId,
        baseRevision: options.baseRevision,
        transactionId,
        idempotencyKey: `${plan.planId}:${stepId}:${index}`,
        actor: options.actor,
        preconditions: step.preconditions,
        type: command.type,
        params: command.payload,
      }),
    );
    envelopes.push(...stepEnvelopes);
    steps.push({ stepId, status: 'staged', envelopes: stepEnvelopes });
  }

  const staged = staging.commands;
  if (errors.length > 0 || staged.length === 0) {
    if (staged.length === 0 && errors.length === 0) {
      errors.push('plan staged no commands');
    }
    return {
      planId: plan.planId,
      transactionId,
      committed: false,
      replayed: false,
      idempotencyKey,
      transactionLabel,
      steps,
      commands: staged,
      envelopes,
      stagedProject: staging.project,
      baseRevision: options.baseRevision,
      errors,
    };
  }

  // Nothing has touched the real project up to this point. Refuse the commit if
  // it moved while we were planning rather than applying stale edits.
  checkBaseRevision(options.baseRevision, options.currentRevision());

  const commitResult = options.commit({
    label: transactionLabel,
    commands: [...staged],
  });

  if (!commitResult.success) {
    errors.push(`commit failed: ${commitResult.error ?? 'unknown error'}`);
    options.idempotency?.recordFailure(
      idempotencyKey,
      plan.planId,
      '__transaction__',
      commitResult.error ?? 'unknown error',
    );
  } else {
    options.idempotency?.recordExecution(idempotencyKey, plan.planId, '__transaction__', {
      success: true,
    });
  }

  return {
    planId: plan.planId,
    transactionId,
    committed: commitResult.success,
    replayed: false,
    idempotencyKey,
    transactionLabel,
    steps,
    commands: staged,
    envelopes,
    stagedProject: staging.project,
    baseRevision: options.baseRevision,
    errors,
  };
}
