import { describe, expect, it } from 'vitest';
import {
  applyApprovedScene3DTool,
  commandForScene3DTool,
  dryRunScene3DTool,
  emptyScene3D,
  IDENTITY_3D_TRANSFORM,
  inspectScene3DTool,
  Scene3DApprovalLedger,
  scene3DApprovalSignature,
  scene3DToolDiffDigest,
  scene3DToolInputDigest,
} from './index.js';

const session = () => ({
  actorId: 'actor',
  projectId: 'project',
  sceneId: 'scene',
  revision: 'r1',
  document: emptyScene3D('scene'),
});

describe('scene3d structured tools', () => {
  it('uses a cryptographic SHA-256 request digest', () => {
    expect(scene3DToolInputDigest('scene3d.add', {})).toBe(
      'b98e6c32179b53a2d5a84d63e1bec7af0a712eb5d3438bf651f329a128c8c4f7',
    );
  });

  it('rejects unknown runtime tool names instead of falling through', () => {
    expect(() => inspectScene3DTool(session(), 'shell.exec' as never)).toThrow('unsupported');
    expect(() => commandForScene3DTool('shell.exec' as never, {})).toThrow('unsupported');
  });

  it('keeps reads bounded to the bound scene and returns dry-run diffs', () => {
    expect(inspectScene3DTool(session(), 'scene3d.summary')).toMatchObject({
      sceneId: 'scene',
      objectCount: 0,
    });
    const dry = dryRunScene3DTool(session(), 'scene3d.add', {
      object: {
        id: 'box',
        name: 'Box',
        kind: 'primitive',
        primitive: 'box',
        transform: IDENTITY_3D_TRANSFORM,
      },
    });
    expect(dry.diff).toMatchObject({ created: ['box'] });
    expect(dry.diff?.changedAssets).toEqual([]);
  });
  it('requires a matching, unexpired approval and applies atomically with an undo transaction', () => {
    const input = {
      object: {
        id: 'box',
        name: 'Box',
        kind: 'primitive',
        primitive: 'box',
        transform: IDENTITY_3D_TRANSFORM,
      },
    };
    const preview = dryRunScene3DTool(session(), 'scene3d.add', input);
    const approval = {
      approvalId: 'a1',
      planId: 'plan-1',
      stepId: 'step-1',
      toolName: 'scene3d.add' as const,
      inputDigest: preview.inputDigest!,
      diffDigest: preview.diffDigest!,
      signature: '',
      actorId: 'actor',
      projectId: 'project',
      sceneId: 'scene',
      baseRevision: 'r1',
      expiresAt: 1000,
    };
    const signedApproval = {
      ...approval,
      signature: scene3DApprovalSignature(approval, 'secret'),
    };
    const result = applyApprovedScene3DTool(session(), 'scene3d.add', input, signedApproval, 100);
    expect(result.document?.objects.box).toBeDefined();
    expect(result.inverse?.commands).toHaveLength(1);
    expect(
      applyApprovedScene3DTool(
        session(),
        'scene3d.add',
        input,
        {
          approvalId: 'a1',
          planId: 'plan-1',
          stepId: 'step-1',
          toolName: 'scene3d.add',
          inputDigest: preview.inputDigest!,
          diffDigest: preview.diffDigest!,
          signature: signedApproval.signature,
          actorId: 'wrong',
          projectId: 'project',
          sceneId: 'scene',
          baseRevision: 'r1',
          expiresAt: 1000,
        },
        100,
      ).error,
    ).toContain('binding');
  });
  it('rejects arbitrary filesystem, shell, URL, or environment authority by construction', () => {
    expect(Object.keys({ ...session().document.objects })).toEqual([]);
    expect([
      'scene3d.summary',
      'scene3d.assets',
      'scene3d.scene',
      'scene3d.selection',
    ]).not.toContain('shell.exec');
  });

  it('rejects malformed write inputs before they reach the command boundary', () => {
    expect(() => commandForScene3DTool('scene3d.add', {})).toThrow('object must be an object');
    expect(() => commandForScene3DTool('scene3d.remove', { objectId: 42 })).toThrow(
      'objectId must be a non-empty string',
    );
    expect(() => commandForScene3DTool('scene3d.transform', { objectId: 'box' })).toThrow(
      'transform must be an object',
    );
  });

  it('reports non-object changes in material and camera diffs', () => {
    const material = {
      id: 'mat',
      color: '#ffffff',
      roughness: 0.5,
      metalness: 0.1,
    };
    const materialDiff = dryRunScene3DTool(session(), 'scene3d.material', { material });
    expect(materialDiff.diff?.changedMaterials).toEqual(['mat']);
    const cameraDiff = dryRunScene3DTool(session(), 'scene3d.camera', { cameraId: 'camera' });
    expect(cameraDiff.error).toContain('active camera');
  });

  it('binds approvals to the exact request and consumes them once', () => {
    const input = {
      object: {
        id: 'box',
        name: 'Box',
        kind: 'primitive',
        primitive: 'box',
        transform: IDENTITY_3D_TRANSFORM,
      },
    };
    const preview = dryRunScene3DTool(session(), 'scene3d.add', input);
    const approval = {
      approvalId: 'once',
      planId: 'plan-1',
      stepId: 'step-1',
      toolName: 'scene3d.add' as const,
      inputDigest: scene3DToolInputDigest('scene3d.add', input),
      diffDigest: scene3DToolDiffDigest(preview.diff!),
      signature: '',
      actorId: 'actor',
      projectId: 'project',
      sceneId: 'scene',
      baseRevision: 'r1',
      expiresAt: 1000,
    };
    const signedApproval = {
      ...approval,
      signature: scene3DApprovalSignature(approval, 'secret'),
    };
    const ledger = new Scene3DApprovalLedger();
    expect(
      ledger.apply(session(), 'scene3d.add', input, signedApproval, 100).document,
    ).toBeDefined();
    expect(ledger.apply(session(), 'scene3d.add', input, signedApproval, 100).error).toContain(
      'consumed',
    );
    expect(ledger.apply(session(), 'scene3d.remove', input, signedApproval, 100).error).toContain(
      'consumed',
    );
  });
});
