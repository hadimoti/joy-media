import { describe, expect, it } from 'vitest';
import { Scene3DMcpGateway, Scene3DPlanExecutor, createToolRegistry } from './index.js';
import {
  dryRunScene3DTool,
  emptyScene3D,
  IDENTITY_3D_TRANSFORM,
  scene3DToolDiffDigest,
  scene3DToolInputDigest,
} from '@joy-media/scene3d-core';

describe('Scene3DMcpGateway', () => {
  it('binds reads, previews, and approved calls to a live session/commit seam', () => {
    let document = emptyScene3D('scene');
    const session = () => ({
      actorId: 'actor',
      projectId: 'project',
      sceneId: 'scene',
      revision: 'r1',
      document,
    });
    const input = {
      object: {
        id: 'box',
        name: 'Box',
        kind: 'primitive' as const,
        primitive: 'box' as const,
        transform: IDENTITY_3D_TRANSFORM,
      },
    };
    const preview = dryRunScene3DTool(session(), 'scene3d.add', input);
    const gateway = new Scene3DMcpGateway({
      registry: createToolRegistry(),
      executor: new Scene3DPlanExecutor({
        registry: createToolRegistry(),
        authorize: () => ({ allowed: true }),
        now: () => 100,
      }),
      binding: {
        getSession: session,
        commit: {
          commit: (result) => {
            document = result.document;
          },
        },
      },
    });
    expect(gateway.listTools().some((tool) => tool.name === 'scene3d.add')).toBe(true);
    expect(gateway.read('scene3d.summary')).toMatchObject({ sceneId: 'scene' });
    const result = gateway.callApproved({
      planId: 'p',
      stepId: 's',
      idempotencyKey: 'p:s:0',
      name: 'scene3d.add',
      input,
      approval: {
        approvalId: 'a',
        toolName: 'scene3d.add',
        inputDigest: scene3DToolInputDigest('scene3d.add', input),
        diffDigest: scene3DToolDiffDigest(preview.diff!),
        actorId: 'actor',
        projectId: 'project',
        sceneId: 'scene',
        baseRevision: 'r1',
        expiresAt: 1000,
      },
    });
    expect(result.status).toBe('success');
    expect(document.objects.box).toBeDefined();
  });
});
