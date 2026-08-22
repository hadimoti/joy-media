import { describe, expect, it } from 'vitest';
import {
  Scene3DPlanExecutor,
  createToolRegistry,
  createIdempotencyStore,
  createAuditTrail,
} from './index.js';
import {
  dryRunScene3DTool,
  emptyScene3D,
  IDENTITY_3D_TRANSFORM,
  scene3DToolDiffDigest,
  scene3DToolInputDigest,
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
  return {
    planId: 'plan-1',
    stepId: 'step-1',
    idempotencyKey: 'plan-1:step-1:0',
    session,
    name: 'scene3d.add' as const,
    input,
    approval: {
      approvalId: 'approval-1',
      toolName: 'scene3d.add' as const,
      inputDigest: scene3DToolInputDigest('scene3d.add', input),
      diffDigest: scene3DToolDiffDigest(preview.diff!),
      actorId: 'actor',
      projectId: 'project',
      sceneId: 'scene',
      baseRevision: 'r1',
      expiresAt: 1000,
    },
  };
}

describe('Scene3DPlanExecutor', () => {
  it('commits approved changes and records audit/idempotency state', () => {
    const saved: unknown[] = [];
    const audit = createAuditTrail();
    const executor = new Scene3DPlanExecutor({
      registry: createToolRegistry(),
      authorize: () => ({ allowed: true }),
      idempotency: createIdempotencyStore(),
      audit,
      now: () => 100,
    });
    const result = executor.execute({
      ...request(),
      commit: { commit: (value) => saved.push(value) },
    });
    expect(result.status).toBe('success');
    expect(saved).toHaveLength(1);
    expect(audit.getEntriesByAction('step-completed')).toHaveLength(1);
  });

  it('returns replay without committing twice', () => {
    const saved: unknown[] = [];
    const executor = new Scene3DPlanExecutor({
      registry: createToolRegistry(),
      authorize: () => ({ allowed: true }),
      now: () => 100,
    });
    const first = executor.execute({
      ...request(),
      commit: { commit: (value) => saved.push(value) },
    });
    const second = executor.execute({
      ...request(),
      commit: { commit: (value) => saved.push(value) },
    });
    expect(first.status).toBe('success');
    expect(second.status).toBe('replayed');
    expect(saved).toHaveLength(1);
  });
});
