import { describe, expect, it } from 'vitest';
import {
  Scene3DMcpGateway,
  Scene3DMcpServer,
  Scene3DPlanExecutor,
  createToolRegistry,
  createIdempotencyStore,
} from './index.js';
import {
  dryRunScene3DTool,
  emptyScene3D,
  IDENTITY_3D_TRANSFORM,
  scene3DToolDiffDigest,
  scene3DToolInputDigest,
  scene3DApprovalSignature,
  Scene3DApprovalLedger,
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
        approvalSecret: 'secret',
        approvalStore: new Scene3DApprovalLedger(),
        idempotency: createIdempotencyStore(),
        now: () => 100,
      }),
      binding: {
        getSession: session,
        commit: {
          commit: (result) => {
            document = result.document;
            return { accepted: true };
          },
        },
      },
    });
    expect(gateway.listTools().some((tool) => tool.name === 'scene3d.add')).toBe(true);
    expect(gateway.read('scene3d.summary')).toMatchObject({ sceneId: 'scene' });
    const approval = {
      approvalId: 'a',
      toolName: 'scene3d.add' as const,
      inputDigest: scene3DToolInputDigest('scene3d.add', input),
      diffDigest: scene3DToolDiffDigest(preview.diff!),
      actorId: 'actor',
      projectId: 'project',
      sceneId: 'scene',
      baseRevision: 'r1',
      expiresAt: 1000,
    };
    const result = gateway.callApproved({
      planId: 'p',
      stepId: 's',
      idempotencyKey: 'p:s:0',
      name: 'scene3d.add',
      input,
      approval: { ...approval, signature: scene3DApprovalSignature(approval, 'secret') },
    });
    expect(result.status).toBe('success');
    expect(document.objects.box).toBeDefined();
  });

  it('handles MCP JSON-RPC and enforces the scene3d allow-list', () => {
    const gateway = new Scene3DMcpGateway({
      registry: createToolRegistry(),
      executor: new Scene3DPlanExecutor({
        registry: createToolRegistry(),
        authorize: () => ({ allowed: true }),
        approvalSecret: 'secret',
        approvalStore: new Scene3DApprovalLedger(),
        idempotency: createIdempotencyStore(),
      }),
      binding: {
        getSession: () => ({
          actorId: 'actor',
          projectId: 'project',
          sceneId: 'scene',
          revision: 'r1',
          document: emptyScene3D('scene'),
        }),
        commit: { commit: () => ({ accepted: true }) },
      },
    });
    const server = new Scene3DMcpServer(gateway);
    expect(server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' }).result).toMatchObject({
      protocolVersion: '2025-06-18',
    });
    expect(server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result).toMatchObject({
      tools: expect.any(Array),
    });
    expect(
      server.handle({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'scene3d.summary', arguments: {} },
      }).result,
    ).toBeDefined();
    expect(
      server.handle({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'scene3d.remove', arguments: {}, approval: {} },
      }).error?.message,
    ).toContain('objectId');
    expect(
      server.handle({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'shell.exec', arguments: {} },
      }).error?.message,
    ).toContain('allow-list');
  });
});
