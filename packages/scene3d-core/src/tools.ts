import {
  applyScene3DTransaction,
  type Scene3DCommand,
  type Scene3DTransaction,
} from './commands.js';
import type { Scene3DDocumentV1 } from './scene.js';

export type Scene3DReadTool =
  'scene3d.summary' | 'scene3d.assets' | 'scene3d.scene' | 'scene3d.selection';
export type Scene3DWriteTool =
  'scene3d.add' | 'scene3d.transform' | 'scene3d.material' | 'scene3d.remove' | 'scene3d.camera';
export type Scene3DToolName = Scene3DReadTool | Scene3DWriteTool;

export interface Scene3DToolDefinition {
  readonly name: Scene3DToolName;
  readonly description: string;
  readonly readOnly: boolean;
  readonly requiresApproval: boolean;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface Scene3DApprovalBinding {
  readonly approvalId: string;
  readonly toolName: Scene3DWriteTool;
  readonly inputDigest: string;
  readonly diffDigest: string;
  readonly actorId: string;
  readonly projectId: string;
  readonly sceneId: string;
  readonly baseRevision: string;
  readonly expiresAt: number;
}

export interface Scene3DToolSession {
  readonly actorId: string;
  readonly projectId: string;
  readonly sceneId: string;
  readonly revision: string;
  readonly document: Scene3DDocumentV1;
  readonly selectedObjectId?: string;
}

export interface Scene3DToolDiff {
  readonly created: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly changedAssets: readonly string[];
  readonly changedMaterials: readonly string[];
  readonly environmentChanged: boolean;
  readonly activeCameraChanged: boolean;
  readonly summary: string;
}

export interface Scene3DToolApplyResult {
  readonly document?: Scene3DDocumentV1;
  readonly revision?: string;
  readonly inverse?: Scene3DTransaction;
  readonly diff?: Scene3DToolDiff;
  readonly error?: string;
}

export const SCENE3D_TOOL_DEFINITIONS: readonly Scene3DToolDefinition[] = [
  ...(['scene3d.summary', 'scene3d.assets', 'scene3d.scene', 'scene3d.selection'] as const).map(
    (name) => ({
      name,
      description: `Read ${name} from the bound 3D scene`,
      readOnly: true,
      requiresApproval: false,
      inputSchema: { type: 'object' },
    }),
  ),
  {
    name: 'scene3d.add',
    description: 'Propose adding a bounded 3D object',
    readOnly: false,
    requiresApproval: true,
    inputSchema: { type: 'object', required: ['object'] },
  },
  {
    name: 'scene3d.transform',
    description: 'Propose a transform change',
    readOnly: false,
    requiresApproval: true,
    inputSchema: { type: 'object', required: ['objectId', 'transform'] },
  },
  {
    name: 'scene3d.material',
    description: 'Propose assigning or upserting a material',
    readOnly: false,
    requiresApproval: true,
    inputSchema: { type: 'object' },
  },
  {
    name: 'scene3d.remove',
    description: 'Propose removing an object',
    readOnly: false,
    requiresApproval: true,
    inputSchema: { type: 'object', required: ['objectId'] },
  },
  {
    name: 'scene3d.camera',
    description: 'Propose changing the active camera',
    readOnly: false,
    requiresApproval: true,
    inputSchema: { type: 'object' },
  },
];

export function inspectScene3DTool(session: Scene3DToolSession, tool: Scene3DReadTool): unknown {
  if (tool === 'scene3d.summary')
    return {
      sceneId: session.sceneId,
      name: session.document.name,
      revision: session.revision,
      objectCount: Object.keys(session.document.objects).length,
      assetCount: Object.keys(session.document.assets).length,
    };
  if (tool === 'scene3d.assets')
    return Object.values(session.document.assets).map((asset) => ({ ...asset }));
  if (tool === 'scene3d.selection')
    return session.selectedObjectId === undefined
      ? undefined
      : session.document.objects[session.selectedObjectId];
  return session.document;
}

export function commandForScene3DTool(
  name: Scene3DWriteTool,
  input: Readonly<Record<string, unknown>>,
): Scene3DCommand {
  if (name === 'scene3d.add')
    return {
      type: 'object.add',
      payload: {
        object: requireRecord(
          input.object,
          'object',
        ) as unknown as Scene3DDocumentV1['objects'][string],
      },
    };
  if (name === 'scene3d.transform')
    return {
      type: 'object.setTransform',
      payload: {
        objectId: requireString(input.objectId, 'objectId'),
        transform: requireRecord(
          input.transform,
          'transform',
        ) as unknown as Scene3DDocumentV1['objects'][string]['transform'],
      },
    };
  if (name === 'scene3d.material') {
    if (input.material !== undefined)
      return {
        type: 'material.upsert',
        payload: {
          material: requireRecord(
            input.material,
            'material',
          ) as unknown as Scene3DDocumentV1['materials'][string],
        },
      };
    return {
      type: 'object.setMaterial',
      payload: {
        objectId: requireString(input.objectId, 'objectId'),
        ...(input.materialId === undefined
          ? {}
          : { materialId: requireString(input.materialId, 'materialId') }),
      },
    };
  }
  if (name === 'scene3d.remove')
    return {
      type: 'object.remove',
      payload: { objectId: requireString(input.objectId, 'objectId') },
    };
  return {
    type: 'scene.setActiveCamera',
    payload: {
      ...(input.cameraId === undefined
        ? {}
        : { cameraId: requireString(input.cameraId, 'cameraId') }),
    },
  };
}

export function dryRunScene3DTool(
  session: Scene3DToolSession,
  name: Scene3DWriteTool,
  input: Readonly<Record<string, unknown>>,
): {
  readonly diff?: Scene3DToolDiff;
  readonly inverse?: Scene3DTransaction;
  readonly inputDigest?: string;
  readonly diffDigest?: string;
  readonly error?: string;
} {
  try {
    const command = commandForScene3DTool(name, input);
    const result = applyScene3DTransaction(session.document, {
      label: `Dry run ${name}`,
      commands: [command],
    });
    return {
      diff: diffForScene(session.document, result.document),
      inverse: result.record.inverses,
      inputDigest: scene3DToolInputDigest(name, input),
      diffDigest: scene3DToolDiffDigest(diffForScene(session.document, result.document)),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function applyApprovedScene3DTool(
  session: Scene3DToolSession,
  name: Scene3DWriteTool,
  input: Readonly<Record<string, unknown>>,
  approval: Scene3DApprovalBinding,
  now = Date.now(),
): Scene3DToolApplyResult {
  if (
    approval.actorId !== session.actorId ||
    approval.projectId !== session.projectId ||
    approval.sceneId !== session.sceneId
  )
    return { error: 'approval binding does not match this scene session' };
  if (approval.baseRevision !== session.revision) return { error: 'scene revision is stale' };
  if (approval.expiresAt <= now) return { error: 'scene approval has expired' };
  if (approval.toolName !== name) return { error: 'approval tool does not match requested tool' };
  const preview = dryRunScene3DTool(session, name, input);
  if (preview.error !== undefined || preview.inverse === undefined || preview.diff === undefined)
    return { error: preview.error ?? 'scene change was rejected' };
  if (approval.inputDigest !== preview.inputDigest)
    return { error: 'approval input digest does not match request' };
  if (approval.diffDigest !== preview.diffDigest)
    return { error: 'approval diff digest does not match dry run' };
  const command = commandForScene3DTool(name, input);
  const result = applyScene3DTransaction(session.document, {
    label: `Approved ${name}`,
    commands: [command],
  });
  return {
    document: result.document,
    revision: `${session.revision}:scene3d:${approval.approvalId}`,
    inverse: result.record.inverses,
    diff: preview.diff,
  };
}

/** Stateful guard for hosts that must reject a retried approval. */
export class Scene3DApprovalLedger {
  private readonly consumed = new Set<string>();

  hasConsumed(approvalId: string): boolean {
    return this.consumed.has(approvalId);
  }

  apply(
    session: Scene3DToolSession,
    name: Scene3DWriteTool,
    input: Readonly<Record<string, unknown>>,
    approval: Scene3DApprovalBinding,
    now = Date.now(),
  ): Scene3DToolApplyResult {
    if (this.consumed.has(approval.approvalId))
      return { error: 'scene approval has already been consumed' };
    const result = applyApprovedScene3DTool(session, name, input, approval, now);
    if (result.document !== undefined) this.consumed.add(approval.approvalId);
    return result;
  }
}

export function scene3DToolInputDigest(
  name: Scene3DWriteTool,
  input: Readonly<Record<string, unknown>>,
): string {
  return fingerprint(`${name}:${JSON.stringify(input)}`);
}

export function scene3DToolDiffDigest(diff: Scene3DToolDiff): string {
  return fingerprint(JSON.stringify(diff));
}

function diffForScene(before: Scene3DDocumentV1, after: Scene3DDocumentV1): Scene3DToolDiff {
  const beforeIds = new Set(Object.keys(before.objects));
  const afterIds = new Set(Object.keys(after.objects));
  const created = [...afterIds].filter((id) => !beforeIds.has(id));
  const deleted = [...beforeIds].filter((id) => !afterIds.has(id));
  const modified = [...afterIds].filter(
    (id) =>
      beforeIds.has(id) && JSON.stringify(before.objects[id]) !== JSON.stringify(after.objects[id]),
  );
  const changedAssets = changedRecordIds(before.assets, after.assets);
  const changedMaterials = changedRecordIds(before.materials, after.materials);
  const environmentChanged =
    JSON.stringify(before.environment) !== JSON.stringify(after.environment);
  const activeCameraChanged = before.activeCameraId !== after.activeCameraId;
  return {
    created,
    modified,
    deleted,
    changedAssets,
    changedMaterials,
    environmentChanged,
    activeCameraChanged,
    summary: `${created.length} created, ${modified.length} modified, ${deleted.length} deleted; ${changedAssets.length} assets, ${changedMaterials.length} materials${environmentChanged ? ', environment changed' : ''}${activeCameraChanged ? ', active camera changed' : ''}`,
  };
}

function changedRecordIds(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): readonly string[] {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...ids].filter((id) => JSON.stringify(before[id]) !== JSON.stringify(after[id]));
}

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new TypeError(`${field} must be a non-empty string`);
  return value;
}
