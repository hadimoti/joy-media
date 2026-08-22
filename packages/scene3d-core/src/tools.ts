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
  readonly planId: string;
  readonly stepId: string;
  readonly toolName: Scene3DWriteTool;
  readonly inputDigest: string;
  readonly diffDigest: string;
  /** Secret-bound receipt signature issued by the host approval service. */
  readonly signature: string;
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

/** Durable approval state seam required by the host execution boundary. */
export interface Scene3DApprovalStore {
  hasConsumed(approvalId: string): boolean;
  markConsumed(approvalId: string): void;
  release(approvalId: string): void;
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
  if (!['scene3d.summary', 'scene3d.assets', 'scene3d.scene', 'scene3d.selection'].includes(tool))
    throw new RangeError(`unsupported scene3d read tool: ${String(tool)}`);
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
  if (
    ![
      'scene3d.add',
      'scene3d.transform',
      'scene3d.material',
      'scene3d.remove',
      'scene3d.camera',
    ].includes(name)
  )
    throw new RangeError(`unsupported scene3d write tool: ${String(name)}`);
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
export class Scene3DApprovalLedger implements Scene3DApprovalStore {
  private readonly consumed = new Set<string>();

  hasConsumed(approvalId: string): boolean {
    return this.consumed.has(approvalId);
  }

  release(approvalId: string): void {
    this.consumed.delete(approvalId);
  }

  markConsumed(approvalId: string): void {
    this.consumed.add(approvalId);
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
    if (result.document !== undefined) this.markConsumed(approval.approvalId);
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

/** Creates the host-bound receipt signature for an approval binding. */
export function scene3DApprovalSignature(
  approval: Omit<Scene3DApprovalBinding, 'signature'>,
  secret: string,
): string {
  if (secret.length === 0) throw new Error('scene3d approval secret must not be empty');
  const canonical = JSON.stringify({
    approvalId: approval.approvalId,
    planId: approval.planId,
    stepId: approval.stepId,
    toolName: approval.toolName,
    inputDigest: approval.inputDigest,
    diffDigest: approval.diffDigest,
    actorId: approval.actorId,
    projectId: approval.projectId,
    sceneId: approval.sceneId,
    baseRevision: approval.baseRevision,
    expiresAt: approval.expiresAt,
  });
  return fingerprint(`${secret}:${canonical}`);
}

export function verifyScene3DApprovalSignature(
  approval: Scene3DApprovalBinding,
  secret: string,
): boolean {
  return approval.signature === scene3DApprovalSignature(approval, secret);
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
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bytes = new TextEncoder().encode(value);
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLength >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  let [a, b, c, d, e, f, g, h] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [aa, bb, cc, dd, ee, ff, gg, hh] = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(ee, 6) ^ rotr(ee, 11) ^ rotr(ee, 25);
      const choice = (ee & ff) ^ (~ee & gg);
      const temp1 = (hh + s1 + choice + constants[i]! + w[i]!) >>> 0;
      const s0 = rotr(aa, 2) ^ rotr(aa, 13) ^ rotr(aa, 22);
      const majority = (aa & bb) ^ (aa & cc) ^ (bb & cc);
      const temp2 = (s0 + majority) >>> 0;
      [hh, gg, ff, ee, dd, cc, bb, aa] = [
        gg,
        ff,
        ee,
        (dd + temp1) >>> 0,
        cc,
        bb,
        aa,
        (temp1 + temp2) >>> 0,
      ];
    }
    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
    e = (e + ee) >>> 0;
    f = (f + ff) >>> 0;
    g = (g + gg) >>> 0;
    h = (h + hh) >>> 0;
  }
  return [a, b, c, d, e, f, g, h].map((word) => word.toString(16).padStart(8, '0')).join('');
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
