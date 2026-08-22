import {
  Scene3DApprovalLedger,
  type Scene3DApprovalBinding,
  type Scene3DDocumentV1,
  type Scene3DToolDiff,
  type Scene3DToolSession,
  type Scene3DToolApplyResult,
  type Scene3DWriteTool,
} from '@joy-media/scene3d-core';
import type { AgentPlanStep } from './plan.js';
import type { ApprovalEngine } from './approval.js';
import type { EditorContext } from './context.js';
import { createAuditTrail, type AuditTrail } from './audit.js';
import { createIdempotencyStore, type IdempotencyStore } from './idempotency.js';
import type { ToolRegistry } from './registry.js';
import type { ToolResult } from './types.js';

export interface Scene3DCommit {
  readonly commit: (result: {
    readonly document: Scene3DDocumentV1;
    readonly revision: string;
    readonly expectedRevision: string;
    readonly diff: Scene3DToolDiff;
  }) => void | { readonly accepted: boolean; readonly error?: string };
}

export interface Scene3DExecutionRequest {
  readonly planId: string;
  readonly stepId: string;
  readonly idempotencyKey: string;
  readonly session: Scene3DToolSession;
  readonly name: Scene3DWriteTool;
  readonly input: Readonly<Record<string, unknown>>;
  readonly approval: Scene3DApprovalBinding;
  readonly commit: Scene3DCommit;
  readonly planStep?: AgentPlanStep;
  readonly editorContext?: EditorContext;
}

export interface Scene3DExecutionResult {
  readonly status: 'success' | 'replayed' | 'blocked' | 'failed';
  readonly document?: Scene3DDocumentV1;
  readonly revision?: string;
  readonly diff?: Scene3DToolDiff;
  readonly inverse?: Scene3DToolApplyResult['inverse'];
  readonly error?: string;
  readonly idempotencyKey: string;
}

export interface Scene3DPlanExecutorOptions {
  readonly registry: ToolRegistry;
  /** Host policy decision; the gateway cannot self-authorize a write. */
  readonly authorize: (request: Scene3DExecutionRequest) => {
    readonly allowed: boolean;
    readonly reason?: string;
  };
  readonly approvalEngine?: ApprovalEngine;
  readonly idempotency?: IdempotencyStore;
  readonly audit?: AuditTrail;
  readonly now?: () => number;
}

/** Executes the bounded Scene3D adapter through the same plan/policy/audit seams as other tools. */
export class Scene3DPlanExecutor {
  private readonly registry: ToolRegistry;
  private readonly authorize: Scene3DPlanExecutorOptions['authorize'];
  private readonly approvalEngine: ApprovalEngine | undefined;
  private readonly idempotency: IdempotencyStore;
  private readonly audit: AuditTrail;
  private readonly approvals = new Scene3DApprovalLedger();
  private readonly now: () => number;

  constructor(options: Scene3DPlanExecutorOptions) {
    this.registry = options.registry;
    this.authorize = options.authorize;
    this.approvalEngine = options.approvalEngine;
    this.idempotency = options.idempotency ?? createIdempotencyStore();
    this.audit = options.audit ?? createAuditTrail();
    this.now = options.now ?? Date.now;
  }

  execute(request: Scene3DExecutionRequest): Scene3DExecutionResult {
    const definition = this.registry.tools.get(request.name);
    if (definition === undefined) return this.fail(request, 'scene3d tool is not registered');
    if (this.idempotency.hasExecuted(request.idempotencyKey))
      return { status: 'replayed', idempotencyKey: request.idempotencyKey };
    const authorization = this.authorize(request);
    if (!authorization.allowed)
      return this.fail(
        request,
        authorization.reason ?? 'scene3d write blocked by policy',
        'blocked',
      );
    if (
      this.approvalEngine !== undefined &&
      request.planStep !== undefined &&
      request.editorContext !== undefined
    ) {
      const decision = this.approvalEngine.evaluateStep(
        request.planStep,
        request.editorContext,
        definition.scope,
      );
      if (decision.decision === 'blocked') return this.fail(request, decision.reason, 'blocked');
    }
    this.audit.record({
      planId: request.planId,
      stepId: request.stepId,
      action: 'step-started',
      tool: request.name,
      userId: request.session.actorId,
    });
    const result = this.approvals.apply(
      request.session,
      request.name,
      request.input,
      request.approval,
      this.now(),
    );
    if (
      result.error !== undefined ||
      result.document === undefined ||
      result.revision === undefined ||
      result.diff === undefined
    )
      return this.fail(request, result.error ?? 'scene3d tool failed');
    const commitResult = request.commit.commit({
      document: result.document,
      revision: result.revision,
      expectedRevision: request.session.revision,
      diff: result.diff,
    });
    if (commitResult !== undefined && !commitResult.accepted) {
      this.approvals.release(request.approval.approvalId);
      return this.fail(
        request,
        commitResult.error ?? 'scene revision changed before commit; retry from a fresh session',
      );
    }
    const toolResult: ToolResult = {
      success: true,
      stableIds: [...result.diff.created, ...result.diff.modified],
      diff: {
        created: result.diff.created,
        modified: result.diff.modified,
        deleted: result.diff.deleted,
        summary: result.diff.summary,
      },
    };
    this.idempotency.recordExecution(
      request.idempotencyKey,
      request.planId,
      request.stepId,
      toolResult,
    );
    this.audit.record({
      planId: request.planId,
      stepId: request.stepId,
      action: 'step-completed',
      tool: request.name,
      userId: request.session.actorId,
      result: toolResult,
    });
    return {
      status: 'success',
      document: result.document,
      revision: result.revision,
      diff: result.diff,
      inverse: result.inverse,
      idempotencyKey: request.idempotencyKey,
    };
  }

  getAuditTrail(): AuditTrail {
    return this.audit;
  }

  private fail(
    request: Scene3DExecutionRequest,
    error: string,
    status: 'failed' | 'blocked' = 'failed',
  ): Scene3DExecutionResult {
    this.idempotency.recordFailure(request.idempotencyKey, request.planId, request.stepId, error);
    this.audit.record({
      planId: request.planId,
      stepId: request.stepId,
      action: 'step-failed',
      tool: request.name,
      userId: request.session.actorId,
      error,
    });
    return { status, error, idempotencyKey: request.idempotencyKey };
  }
}
