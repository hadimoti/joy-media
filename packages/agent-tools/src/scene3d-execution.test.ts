import { describe, expect, it } from 'vitest';
import {
  Scene3DPlanExecutor,
  createToolRegistry,
  createIdempotencyStore,
  createAuditTrail,
} from './index.js';
import {
  Scene3DApprovalLedger,
  dryRunScene3DTool,
  emptyScene3D,
  IDENTITY_3D_TRANSFORM,
  scene3DToolDiffDigest,
  scene3DToolInputDigest,
  scene3DApprovalSignature,
} from '@joy-media/scene3d-core';

function request() {
  const session = {
    actorId: 'actor',
    projectId: 'project',
    sceneId: 'scene',
    revision: 'r1',
    document: emptyScene3D('scene'),
  } as const;
  const input = {
    object: {
      id: 'box',
      name: 'Box',
      kind: 'primitive' as const,
      primitive: 'box' as const,
      transform: IDENTITY_3D_TRANSFORM,
    },
  };
  const preview = dryRunScene3DTool(session, 'scene3d.add', input);
  const approval = {
    approvalId: 'approval-1',
    planId: 'plan-1',
    stepId: 'step-1',
    toolName: 'scene3d.add' as const,
    inputDigest: scene3DToolInputDigest('scene3d.add', input),
    diffDigest: scene3DToolDiffDigest(preview.diff!),
    actorId: 'actor',
    projectId: 'project',
    sceneId: 'scene',
    baseRevision: 'r1',
    expiresAt: 1000,
  };
  return {
    planId: 'plan-1',
    stepId: 'step-1',
    idempotencyKey: 'plan-1:step-1:0',
    session,
    name: 'scene3d.add' as const,
    input,
    approval: { ...approval, signature: scene3DApprovalSignature(approval, 'secret') },
  };
}

describe('Scene3DPlanExecutor', () => {
  it('commits approved changes and records audit/idempotency state', () => {
    const saved: unknown[] = [];
    const audit = createAuditTrail();
    const approvalStore = new Scene3DApprovalLedger();
    const idempotency = createIdempotencyStore();
    const executor = new Scene3DPlanExecutor({
      registry: createToolRegistry(),
      authorize: () => ({ allowed: true }),
      approvalSecret: 'secret',
      approvalStore,
      idempotency,
      audit,
      now: () => 100,
    });
    const result = executor.execute({
      ...request(),
      commit: {
        commit: (value) => {
          saved.push(value);
          approvalStore.markConsumed(value.approval.approvalId);
          idempotency.recordExecution(
            value.idempotencyKey,
            value.planId,
            value.stepId,
            value.result,
          );
          return { accepted: true };
        },
      },
    });
    expect(result.status).toBe('success');
    expect(saved).toHaveLength(1);
    expect(audit.getEntriesByAction('step-completed')).toHaveLength(1);
  });

  it('returns replay without committing twice', () => {
    const saved: unknown[] = [];
    const approvalStore = new Scene3DApprovalLedger();
    const idempotency = createIdempotencyStore();
    const executor = new Scene3DPlanExecutor({
      registry: createToolRegistry(),
      authorize: () => ({ allowed: true }),
      approvalSecret: 'secret',
      approvalStore,
      idempotency,
      now: () => 100,
    });
    const first = executor.execute({
      ...request(),
      commit: {
        commit: (value) => {
          saved.push(value);
          approvalStore.markConsumed(value.approval.approvalId);
          idempotency.recordExecution(
            value.idempotencyKey,
            value.planId,
            value.stepId,
            value.result,
          );
          return { accepted: true };
        },
      },
    });
    const second = executor.execute({
      ...request(),
      commit: {
        commit: (value) => {
          saved.push(value);
          return { accepted: true };
        },
      },
    });
    expect(first.status).toBe('success');
    expect(second.status).toBe('replayed');
    expect(saved).toHaveLength(1);
  });

  it('does not consume approval when the host CAS rejects the commit', () => {
    const approvalStore = new Scene3DApprovalLedger();
    const idempotency = createIdempotencyStore();
    const executor = new Scene3DPlanExecutor({
      registry: createToolRegistry(),
      authorize: () => ({ allowed: true }),
      approvalSecret: 'secret',
      approvalStore,
      idempotency,
      now: () => 100,
    });
    const rejected = executor.execute({
      ...request(),
      commit: { commit: () => ({ accepted: false, error: 'stale revision' }) },
    });
    expect(rejected.status).toBe('failed');
    const accepted = executor.execute({
      ...request(),
      commit: {
        commit: (value) => {
          approvalStore.markConsumed(value.approval.approvalId);
          idempotency.recordExecution(
            value.idempotencyKey,
            value.planId,
            value.stepId,
            value.result,
          );
          return { accepted: true };
        },
      },
    });
    expect(accepted.status).toBe('success');
  });

  it('quarantines an approval when the commit outcome is ambiguous', () => {
    const approvalStore = new Scene3DApprovalLedger();
    const idempotency = createIdempotencyStore();
    const executor = new Scene3DPlanExecutor({
      registry: createToolRegistry(),
      authorize: () => ({ allowed: true }),
      approvalSecret: 'secret',
      approvalStore,
      idempotency,
      now: () => 100,
    });
    expect(
      executor.execute({
        ...request(),
        commit: {
          commit: () => {
            throw new Error('storage unavailable');
          },
        },
      }).status,
    ).toBe('failed');
    expect(
      executor.execute({ ...request(), commit: { commit: () => ({ accepted: true }) } }).status,
    ).toBe('failed');
  });

  it('rejects a caller-forged approval receipt before committing', () => {
    const saved: unknown[] = [];
    const executor = new Scene3DPlanExecutor({
      registry: createToolRegistry(),
      authorize: () => ({ allowed: true }),
      approvalSecret: 'secret',
      approvalStore: new Scene3DApprovalLedger(),
      idempotency: createIdempotencyStore(),
      now: () => 100,
    });
    const result = executor.execute({
      ...request(),
      approval: { ...request().approval, signature: 'forged' },
      commit: {
        commit: () => {
          saved.push(true);
          return { accepted: true };
        },
      },
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('signature');
    expect(saved).toHaveLength(0);
  });
});
