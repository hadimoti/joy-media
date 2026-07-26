import type {
  AgentJobClient,
  AgentJobRequest,
  AgentJobResult,
  AgentJobSnapshot,
} from '@joy-media/job-protocol';
import type { CommandDispatchResult, EditorContext } from './context.js';
import type { ApprovalEngine } from './approval.js';
import type { AtomicApprovalGrant } from './atomic.js';
import type { AgentEditPlan, AgentPlanStep } from './plan.js';
import type { IdempotencyTracker } from './idempotency.js';
import { checkBaseRevision, type ProjectRevisionId } from './envelope.js';
import { resolveExecutionOrder } from './execution-order.js';

export type AgentJobRequestTemplate = Omit<
  AgentJobRequest,
  | 'protocolVersion'
  | 'jobId'
  | 'projectId'
  | 'planId'
  | 'stepId'
  | 'baseRevision'
  | 'idempotencyKey'
>;

export interface AsyncAgentRunOptions {
  readonly projectId: string;
  readonly baseRevision: ProjectRevisionId;
  readonly currentRevision: () => ProjectRevisionId;
  readonly context: EditorContext;
  readonly approvalEngine: ApprovalEngine;
  readonly manualApproval?: AtomicApprovalGrant;
  readonly jobClient: AgentJobClient;
  readonly requestForStep: (step: AgentPlanStep, idempotencyKey: string) => AgentJobRequestTemplate;
  /**
   * Builds and dispatches one deterministic domain transaction using completed
   * result asset IDs. It is called only after every job succeeds and the base
   * revision is still current.
   */
  readonly commit: (
    plan: AgentEditPlan,
    results: ReadonlyMap<string, AgentJobResult>,
  ) => CommandDispatchResult;
  readonly idempotency?: IdempotencyTracker;
  readonly idempotencyKey?: string;
  readonly maxJobRetries?: number;
  readonly onJobProgress?: (stepId: string, snapshot: AgentJobSnapshot) => void;
}

export interface AsyncAgentJobOutcome {
  readonly stepId: string;
  readonly jobId: string;
  readonly state: AgentJobSnapshot['state'];
  readonly attempts: number;
  readonly result?: AgentJobResult;
  readonly error?: string;
}

export interface AsyncAgentRunResult {
  readonly planId: string;
  readonly committed: boolean;
  readonly replayed: boolean;
  readonly idempotencyKey: string;
  readonly jobs: readonly AsyncAgentJobOutcome[];
  readonly errors: readonly string[];
}

/**
 * Executes heavy plan steps outside command staging. Only opaque result asset
 * IDs enter the final revision-checked domain transaction.
 */
export async function runPlanWithAsyncJobs(
  plan: AgentEditPlan,
  options: AsyncAgentRunOptions,
): Promise<AsyncAgentRunResult> {
  const idempotencyKey = options.idempotencyKey ?? `agent-async-plan:${plan.planId}`;
  if (options.idempotency?.hasExecuted(idempotencyKey) === true) {
    return {
      planId: plan.planId,
      committed: false,
      replayed: true,
      idempotencyKey,
      jobs: [],
      errors: [],
    };
  }

  const executionOrder = resolveExecutionOrder(plan);
  if (executionOrder.hasCycle) {
    return failed(plan, idempotencyKey, [], ['plan contains circular dependencies']);
  }

  const jobSteps = executionOrder.order
    .map((stepId) => plan.steps.find((step) => step.id === stepId))
    .filter((step): step is AgentPlanStep => step?.mode === 'job');
  if (jobSteps.length === 0) {
    return failed(plan, idempotencyKey, [], ['plan contains no asynchronous job steps']);
  }

  const commandStepIds = new Set(
    plan.steps.filter((step) => step.mode === 'command').map((step) => step.id),
  );
  const invalidDependency = jobSteps.find((step) =>
    step.dependsOn.some((dependency) => commandStepIds.has(dependency)),
  );
  if (invalidDependency !== undefined) {
    return failed(
      plan,
      idempotencyKey,
      [],
      [`job step ${invalidDependency.id} cannot depend on an uncommitted command step`],
    );
  }

  const outcomes: AsyncAgentJobOutcome[] = [];
  const results = new Map<string, AgentJobResult>();
  const maxRetries = Math.max(0, options.maxJobRetries ?? 0);

  for (const step of jobSteps) {
    const decision = options.approvalEngine.evaluateStep(step, options.context);
    if (
      decision.decision === 'blocked' ||
      (decision.decision === 'requires-manual' && options.manualApproval?.planId !== plan.planId)
    ) {
      return failed(plan, idempotencyKey, outcomes, [
        `job step ${step.id} blocked by policy: ${decision.reason}`,
      ]);
    }

    const stepIdempotencyKey = `${idempotencyKey}:${step.id}`;
    const template = options.requestForStep(step, stepIdempotencyKey);
    const jobId = stableJobId(plan.planId, step.id);
    const request: AgentJobRequest = {
      protocolVersion: 1,
      jobId,
      projectId: options.projectId,
      planId: plan.planId,
      stepId: step.id,
      baseRevision: options.baseRevision,
      idempotencyKey: stepIdempotencyKey,
      ...template,
    };

    let snapshot = await options.jobClient.start(request);
    options.onJobProgress?.(step.id, snapshot);
    let retries = 0;
    while (snapshot.state !== 'succeeded') {
      if (snapshot.state === 'failed' && retries < maxRetries) {
        retries += 1;
        snapshot = await options.jobClient.retry(jobId);
        options.onJobProgress?.(step.id, snapshot);
      }
      if (snapshot.state === 'queued' || snapshot.state === 'running') {
        snapshot = await options.jobClient.waitForTerminal(jobId, (update) => {
          options.onJobProgress?.(step.id, update);
        });
        options.onJobProgress?.(step.id, snapshot);
        continue;
      }
      break;
    }

    const error = validateSucceededJob(request, snapshot);
    const outcome: AsyncAgentJobOutcome = {
      stepId: step.id,
      jobId,
      state: snapshot.state,
      attempts: snapshot.attempt,
      ...(snapshot.result === undefined ? {} : { result: snapshot.result }),
      ...(error === undefined ? {} : { error }),
    };
    outcomes.push(outcome);
    if (error !== undefined || snapshot.result === undefined) {
      options.idempotency?.recordFailure(
        idempotencyKey,
        plan.planId,
        step.id,
        error ?? 'job returned no result',
      );
      return failed(plan, idempotencyKey, outcomes, [
        `job step ${step.id} failed: ${error ?? 'job returned no result'}`,
      ]);
    }
    results.set(step.id, snapshot.result);
  }

  try {
    checkBaseRevision(options.baseRevision, options.currentRevision());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'project revision changed';
    options.idempotency?.recordFailure(idempotencyKey, plan.planId, '__transaction__', message);
    return failed(plan, idempotencyKey, outcomes, [message]);
  }

  const commit = options.commit(plan, results);
  if (!commit.success) {
    const message = commit.error ?? 'unknown commit error';
    options.idempotency?.recordFailure(idempotencyKey, plan.planId, '__transaction__', message);
    return failed(plan, idempotencyKey, outcomes, [`commit failed: ${message}`]);
  }
  options.idempotency?.recordExecution(idempotencyKey, plan.planId, '__transaction__', {
    success: true,
  });
  return {
    planId: plan.planId,
    committed: true,
    replayed: false,
    idempotencyKey,
    jobs: outcomes,
    errors: [],
  };
}

function validateSucceededJob(
  request: AgentJobRequest,
  snapshot: AgentJobSnapshot,
): string | undefined {
  if (snapshot.state !== 'succeeded') {
    return snapshot.failureCode ?? `job ended in ${snapshot.state}`;
  }
  if (snapshot.result === undefined) return 'succeeded job omitted its result';
  if (
    snapshot.result.generatedAssetId.length === 0 ||
    snapshot.result.provenance.generatedAssetId !== snapshot.result.generatedAssetId
  ) {
    return 'generated asset identity does not match provenance';
  }
  const expected = request.generation;
  const actual = snapshot.result.provenance;
  if (
    actual.providerId !== expected.providerId ||
    actual.modelId !== expected.modelId ||
    actual.modelVersion !== expected.modelVersion ||
    actual.prompt !== expected.prompt ||
    JSON.stringify(actual.seed) !== JSON.stringify(expected.seed) ||
    JSON.stringify(actual.inputAssetHashes) !== JSON.stringify(expected.inputAssetHashes) ||
    JSON.stringify(actual.parameters) !== JSON.stringify(expected.parameters)
  ) {
    return 'job provenance does not match the approved generation request';
  }
  if (Number.isNaN(Date.parse(actual.createdAt)))
    return 'job provenance has an invalid creation time';
  return undefined;
}

function stableJobId(planId: string, stepId: string): string {
  return `agent-${sanitizeId(planId)}-${sanitizeId(stepId)}`;
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
}

function failed(
  plan: AgentEditPlan,
  idempotencyKey: string,
  jobs: readonly AsyncAgentJobOutcome[],
  errors: readonly string[],
): AsyncAgentRunResult {
  return {
    planId: plan.planId,
    committed: false,
    replayed: false,
    idempotencyKey,
    jobs,
    errors,
  };
}
