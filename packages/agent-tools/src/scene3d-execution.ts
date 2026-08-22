import {
  applyApprovedScene3DTool,
  verifyScene3DApprovalSignature,
  type Scene3DApprovalStore,
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
import type { IdempotencyTracker } from './idempotency.js';
import type { ToolRegistry } from './registry.js';
import type { ToolResult } from './types.js';

export interface Scene3DCommit {
  /**
   * Atomically compare-and-swap the scene, consume the approval receipt, and
   * persist the idempotency result. accepted:false must prove no mutation;
   * a thrown error is ambiguous and must be resolved by the host before retry.
   */
  readonly commit: (result: {
    readonly document: Scene3DDocumentV1;
    readonly revision: string;
    readonly expectedRevision: string;
    readonly diff: Scene3DToolDiff;
    readonly approval: Scene3DApprovalBinding;
    readonly planId: string;
    readonly stepId: string;
    readonly idempotencyKey: string;
    readonly result: ToolResult;
  }) => { readonly accepted: boolean; readonly replayed?: boolean; readonly error?: string };
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
  /** Secret used to verify host-issued approval receipts. */
  readonly approvalSecret: string;
  /** Host-owned durable approval store; in-memory implementations are suitable only for tests. */
  readonly approvalStore: Scene3DApprovalStore;
  readonly approvalEngine?: ApprovalEngine;
  /** Host-owned durable idempotency store. */
  readonly idempotency: IdempotencyTracker;
  readonly audit?: AuditTrail;
  readonly now?: () => number;
}

/** Executes the bounded Scene3D adapter through the same plan/policy/audit seams as other tools. */
export class Scene3DPlanExecutor {
  private readonly registry: ToolRegistry;
  private readonly authorize: Scene3DPlanExecutorOptions['authorize'];
  private readonly approvalEngine: ApprovalEngine | undefined;
  private readonly idempotency: IdempotencyTracker;
  private readonly audit: AuditTrail;
  private readonly approvals: Scene3DApprovalStore;
  private readonly approvalSecret: string;
  private readonly now: () => number;

  constructor(options: Scene3DPlanExecutorOptions) {
    this.registry = options.registry;
    this.authorize = options.authorize;
    if (options.approvalSecret.length === 0)
      throw new Error('scene3d approval secret must not be empty');
    this.approvalSecret = options.approvalSecret;
    this.approvals = options.approvalStore;
    this.approvalEngine = options.approvalEngine;
    this.idempotency = options.idempotency;
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
    if (!verifyScene3DApprovalSignature(request.approval, this.approvalSecret))
      return this.fail(request, 'scene approval signature is invalid');
    if (
      request.approval.planId !== request.planId ||
      request.approval.stepId !== request.stepId
    )
      return this.fail(request, 'scene approval receipt is bound to a different plan step');
    if (this.approvals.hasConsumed(request.approval.approvalId))
      return this.fail(request, 'scene approval has already been consumed');
    this.audit.record({
      planId: request.planId,
      stepId: request.stepId,
      action: 'step-started',
      tool: request.name,
      userId: request.session.actorId,
    });
    const result = applyApprovedScene3DTool(
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
    let commitResult: {
      readonly accepted: boolean;
      readonly replayed?: boolean;
      readonly error?: string;
    };
    try {
      commitResult = request.commit.commit({
        document: result.document,
        revision: result.revision,
        expectedRevision: request.session.revision,
        diff: result.diff,
        approval: request.approval,
        planId: request.planId,
        stepId: request.stepId,
        idempotencyKey: request.idempotencyKey,
        result: toolResult,
      });
    } catch (cause) {
      this.approvals.markConsumed(request.approval.approvalId);
      return this.ambiguousFailure(
        request,
        cause instanceof Error ? cause.message : String(cause),
      );
    }
    if (!commitResult.accepted) {
      this.approvals.release(request.approval.approvalId);
      return this.fail(
        request,
        commitResult.error ?? 'scene revision changed before commit; retry from a fresh session',
      );
    }
    if (commitResult.replayed)
      return { status: 'replayed', idempotencyKey: request.idempotencyKey };
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

  private ambiguousFailure(
    request: Scene3DExecutionRequest,
    error: string,
  ): Scene3DExecutionResult {
    const message = `ambiguous scene3d commit; resolve durable status before retry: ${error}`;
    this.audit.record({
      planId: request.planId,
      stepId: request.stepId,
      action: 'step-failed',
      tool: request.name,
      userId: request.session.actorId,
      error: message,
    });
    return { status: 'failed', error: message, idempotencyKey: request.idempotencyKey };
  }
}
