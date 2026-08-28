# Review package: 32203d0..HEAD

## Commits
2357059 fix(3d): validate persisted scenes and migrate v0
568e702 feat(3d): add durable scene schema validation and commands

## Files changed
 packages/scene3d-core/package.json           |  18 +++
 packages/scene3d-core/src/commands.test.ts   |  87 ++++++++++++
 packages/scene3d-core/src/commands.ts        | 190 +++++++++++++++++++++++++++
 packages/scene3d-core/src/index.ts           |   3 +
 packages/scene3d-core/src/scene.test.ts      |  24 ++++
 packages/scene3d-core/src/scene.ts           | 136 +++++++++++++++++++
 packages/scene3d-core/src/validation.test.ts |  71 ++++++++++
 packages/scene3d-core/src/validation.ts      | 152 +++++++++++++++++++++
 packages/scene3d-core/tsconfig.json          |   5 +
 pnpm-lock.yaml                               |   2 +
 tsconfig.json                                |   1 +
 vitest.config.ts                             |   1 +
 12 files changed, 690 insertions(+)

## Diff
diff --git a/packages/scene3d-core/package.json b/packages/scene3d-core/package.json
new file mode 100644
index 0000000..a68af89
--- /dev/null
+++ b/packages/scene3d-core/package.json
@@ -0,0 +1,18 @@
+{
+  "name": "@joy-media/scene3d-core",
+  "version": "0.0.0",
+  "private": true,
+  "type": "module",
+  "scripts": {
+    "build": "tsc -b",
+    "test": "vitest run"
+  },
+  "main": "./dist/index.js",
+  "types": "./dist/index.d.ts",
+  "exports": {
+    ".": {
+      "types": "./dist/index.d.ts",
+      "default": "./dist/index.js"
+    }
+  }
+}
diff --git a/packages/scene3d-core/src/commands.test.ts b/packages/scene3d-core/src/commands.test.ts
new file mode 100644
index 0000000..f288d82
--- /dev/null
+++ b/packages/scene3d-core/src/commands.test.ts
@@ -0,0 +1,87 @@
+import { describe, expect, it } from 'vitest';
+import { applyScene3DTransaction } from './commands.js';
+import { emptyScene3D, IDENTITY_3D_TRANSFORM, type Scene3DObject } from './scene.js';
+
+const model: Scene3DObject = {
+  id: 'model',
+  name: 'Model',
+  kind: 'model',
+  assetId: 'asset',
+  transform: IDENTITY_3D_TRANSFORM,
+};
+const base = {
+  ...emptyScene3D('s'),
+  assets: {
+    asset: { id: 'asset', kind: 'model' as const, mimeType: 'model/gltf-binary' as const },
+  },
+};
+
+describe('scene3d commands', () => {
+  it('applies multiple commands atomically and returns inverses', () => {
+    const result = applyScene3DTransaction(base, {
+      label: 'Add model',
+      commands: [
+        { type: 'object.add', payload: { object: model } },
+        {
+          type: 'scene.setEnvironment',
+          payload: { environment: { backgroundColor: '#ffffff', ambientIntensity: 0.8 } },
+        },
+      ],
+    });
+    expect(result.document.objects.model).toEqual(model);
+    const restored = applyScene3DTransaction(result.document, result.record.inverses).document;
+    expect(restored).toEqual(base);
+  });
+
+  it('rejects deleting an active camera or a parent with children', () => {
+    const camera: Scene3DObject = {
+      id: 'camera',
+      name: 'Camera',
+      kind: 'camera',
+      transform: IDENTITY_3D_TRANSFORM,
+      camera: { fieldOfViewDeg: 50, near: 0.1, far: 100 },
+    };
+    const parent: Scene3DObject = {
+      id: 'parent',
+      name: 'Parent',
+      kind: 'empty',
+      transform: IDENTITY_3D_TRANSFORM,
+    };
+    const child: Scene3DObject = {
+      id: 'child',
+      name: 'Child',
+      kind: 'empty',
+      parentId: 'parent',
+      transform: IDENTITY_3D_TRANSFORM,
+    };
+    const scene = { ...base, objects: { camera, parent, child }, activeCameraId: 'camera' };
+    expect(() =>
+      applyScene3DTransaction(scene, {
+        label: 'remove',
+        commands: [{ type: 'object.remove', payload: { objectId: 'camera' } }],
+      }),
+    ).toThrow('active camera');
+    expect(() =>
+      applyScene3DTransaction(scene, {
+        label: 'remove',
+        commands: [{ type: 'object.remove', payload: { objectId: 'parent' } }],
+      }),
+    ).toThrow('children');
+  });
+
+  it('does not partially apply when a later command fails', () => {
+    expect(() =>
+      applyScene3DTransaction(base, {
+        label: 'atomic',
+        commands: [
+          { type: 'object.add', payload: { object: model } },
+          {
+            type: 'object.setTransform',
+            payload: { objectId: 'missing', transform: IDENTITY_3D_TRANSFORM },
+          },
+        ],
+      }),
+    ).toThrow('missing');
+    expect(base.objects).toEqual({});
+  });
+});
diff --git a/packages/scene3d-core/src/commands.ts b/packages/scene3d-core/src/commands.ts
new file mode 100644
index 0000000..bd23c75
--- /dev/null
+++ b/packages/scene3d-core/src/commands.ts
@@ -0,0 +1,190 @@
+import { assertValidScene3DDocument, validateScene3DDocument } from './validation.js';
+import type {
+  Scene3DDocumentV1,
+  Scene3DEnvironment,
+  Scene3DMaterial,
+  Scene3DObject,
+  Scene3DTransform,
+} from './scene.js';
+
+export type Scene3DCommand =
+  | { readonly type: 'object.add'; readonly payload: { readonly object: Scene3DObject } }
+  | { readonly type: 'object.remove'; readonly payload: { readonly objectId: string } }
+  | {
+      readonly type: 'object.setTransform';
+      readonly payload: { readonly objectId: string; readonly transform: Scene3DTransform };
+    }
+  | {
+      readonly type: 'object.setMaterial';
+      readonly payload: { readonly objectId: string; readonly materialId?: string };
+    }
+  | { readonly type: 'material.upsert'; readonly payload: { readonly material: Scene3DMaterial } }
+  | { readonly type: 'material.remove'; readonly payload: { readonly materialId: string } }
+  | {
+      readonly type: 'scene.setEnvironment';
+      readonly payload: { readonly environment: Scene3DEnvironment };
+    }
+  | { readonly type: 'scene.setActiveCamera'; readonly payload: { readonly cameraId?: string } };
+export interface Scene3DTransaction {
+  readonly label: string;
+  readonly commands: readonly Scene3DCommand[];
+}
+export interface Scene3DTransactionRecord {
+  readonly transaction: Scene3DTransaction;
+  readonly inverses: Scene3DTransaction;
+}
+
+export function applyScene3DTransaction(
+  document: Scene3DDocumentV1,
+  transaction: Scene3DTransaction,
+): { readonly document: Scene3DDocumentV1; readonly record: Scene3DTransactionRecord } {
+  let next = document;
+  const inverses: Scene3DCommand[] = [];
+  for (const command of transaction.commands) {
+    const result = applyScene3DCommand(next, command);
+    next = result.document;
+    inverses.unshift(result.inverse);
+  }
+  const errors = validateScene3DDocument(next);
+  if (errors.length > 0)
+    throw new RangeError(`scene transaction is invalid: ${errors[0]!.message}`);
+  return {
+    document: next,
+    record: { transaction, inverses: { label: `Undo ${transaction.label}`, commands: inverses } },
+  };
+}
+
+export function applyScene3DCommand(
+  document: Scene3DDocumentV1,
+  command: Scene3DCommand,
+): { readonly document: Scene3DDocumentV1; readonly inverse: Scene3DCommand } {
+  assertValidScene3DDocument(document);
+  const result = applyScene3DCommandUnchecked(document, command);
+  assertValidScene3DDocument(result.document);
+  return result;
+}
+
+function applyScene3DCommandUnchecked(
+  document: Scene3DDocumentV1,
+  command: Scene3DCommand,
+): { readonly document: Scene3DDocumentV1; readonly inverse: Scene3DCommand } {
+  if (command.type === 'object.add') {
+    const object = command.payload.object;
+    if (document.objects[object.id] !== undefined)
+      throw new RangeError(`object "${object.id}" already exists`);
+    if (object.parentId !== undefined && document.objects[object.parentId] === undefined)
+      throw new RangeError(`parent "${object.parentId}" does not exist`);
+    return {
+      document: { ...document, objects: { ...document.objects, [object.id]: object } },
+      inverse: { type: 'object.remove', payload: { objectId: object.id } },
+    };
+  }
+  if (command.type === 'object.remove') {
+    const object = document.objects[command.payload.objectId];
+    if (object === undefined)
+      throw new RangeError(`object "${command.payload.objectId}" does not exist`);
+    if (document.activeCameraId === object.id)
+      throw new RangeError('active camera cannot be removed');
+    if (Object.values(document.objects).some((candidate) => candidate.parentId === object.id))
+      throw new RangeError('object with children cannot be removed');
+    const objects = { ...document.objects };
+    delete objects[object.id];
+    return {
+      document: { ...document, objects },
+      inverse: { type: 'object.add', payload: { object } },
+    };
+  }
+  if (command.type === 'object.setTransform') {
+    const object = document.objects[command.payload.objectId];
+    if (object === undefined)
+      throw new RangeError(`object "${command.payload.objectId}" does not exist`);
+    return {
+      document: {
+        ...document,
+        objects: {
+          ...document.objects,
+          [object.id]: { ...object, transform: command.payload.transform },
+        },
+      },
+      inverse: {
+        type: 'object.setTransform',
+        payload: { objectId: object.id, transform: object.transform },
+      },
+    };
+  }
+  if (command.type === 'object.setMaterial') {
+    const object = document.objects[command.payload.objectId];
+    if (object === undefined)
+      throw new RangeError(`object "${command.payload.objectId}" does not exist`);
+    const nextObject =
+      command.payload.materialId === undefined
+        ? (() => {
+            const { materialId: _previousMaterialId, ...objectWithoutMaterial } = object;
+            return objectWithoutMaterial;
+          })()
+        : { ...object, materialId: command.payload.materialId };
+    return {
+      document: { ...document, objects: { ...document.objects, [object.id]: nextObject } },
+      inverse: {
+        type: 'object.setMaterial',
+        payload: {
+          objectId: object.id,
+          ...(object.materialId === undefined ? {} : { materialId: object.materialId }),
+        },
+      },
+    };
+  }
+  if (command.type === 'material.upsert') {
+    const previous = document.materials[command.payload.material.id];
+    return {
+      document: {
+        ...document,
+        materials: {
+          ...document.materials,
+          [command.payload.material.id]: command.payload.material,
+        },
+      },
+      inverse:
+        previous === undefined
+          ? { type: 'material.remove', payload: { materialId: command.payload.material.id } }
+          : { type: 'material.upsert', payload: { material: previous } },
+    };
+  }
+  if (command.type === 'material.remove') {
+    const material = document.materials[command.payload.materialId];
+    if (material === undefined)
+      throw new RangeError(`material "${command.payload.materialId}" does not exist`);
+    if (Object.values(document.objects).some((object) => object.materialId === material.id))
+      throw new RangeError('material is still referenced');
+    const materials = { ...document.materials };
+    delete materials[material.id];
+    return {
+      document: { ...document, materials },
+      inverse: { type: 'material.upsert', payload: { material } },
+    };
+  }
+  if (command.type === 'scene.setEnvironment')
+    return {
+      document: { ...document, environment: command.payload.environment },
+      inverse: { type: 'scene.setEnvironment', payload: { environment: document.environment } },
+    };
+  const cameraId = command.payload.cameraId;
+  if (cameraId !== undefined && document.objects[cameraId]?.kind !== 'camera')
+    throw new RangeError('active camera must reference a camera object');
+  const nextDocument =
+    cameraId === undefined
+      ? (() => {
+          const { activeCameraId: _previousCameraId, ...documentWithoutCamera } = document;
+          return documentWithoutCamera;
+        })()
+      : { ...document, activeCameraId: cameraId };
+  return {
+    document: nextDocument,
+    inverse: {
+      type: 'scene.setActiveCamera',
+      payload: {
+        ...(document.activeCameraId === undefined ? {} : { cameraId: document.activeCameraId }),
+      },
+    },
+  };
+}
diff --git a/packages/scene3d-core/src/index.ts b/packages/scene3d-core/src/index.ts
new file mode 100644
index 0000000..6908f24
--- /dev/null
+++ b/packages/scene3d-core/src/index.ts
@@ -0,0 +1,3 @@
+export * from './scene.js';
+export * from './validation.js';
+export * from './commands.js';
diff --git a/packages/scene3d-core/src/scene.test.ts b/packages/scene3d-core/src/scene.test.ts
new file mode 100644
index 0000000..b8f0aa8
--- /dev/null
+++ b/packages/scene3d-core/src/scene.test.ts
@@ -0,0 +1,24 @@
+import { describe, expect, it } from 'vitest';
+import { emptyScene3D, IDENTITY_3D_TRANSFORM, migrateScene3DDocument, parseScene3DDocument } from './scene.js';
+
+describe('scene3d document', () => {
+  it('creates a stable JSON-round-trippable empty document', () => {
+    const scene = emptyScene3D('scene-1', 'Hero');
+    expect(JSON.parse(JSON.stringify(scene))).toEqual(scene);
+    expect(scene.durationUs).toBe(5_000_000);
+    expect(IDENTITY_3D_TRANSFORM.scale).toEqual({ x: 1, y: 1, z: 1 });
+  });
+
+  it('migrates the v0 spike shape before validation', () => {
+    const migrated = migrateScene3DDocument({
+      schemaVersion: 0,
+      sceneId: 'legacy-scene',
+      title: 'Legacy',
+      objects: { root: { kind: 'empty', transform: {} } },
+    });
+    expect(migrated.schemaVersion).toBe(1);
+    expect(migrated.id).toBe('legacy-scene');
+    expect(migrated.objects.root?.transform).toEqual(IDENTITY_3D_TRANSFORM);
+    expect(parseScene3DDocument(JSON.stringify(migrated))).toEqual(migrated);
+  });
+});
diff --git a/packages/scene3d-core/src/scene.ts b/packages/scene3d-core/src/scene.ts
new file mode 100644
index 0000000..68dfc44
--- /dev/null
+++ b/packages/scene3d-core/src/scene.ts
@@ -0,0 +1,136 @@
+export const SCENE3D_SCHEMA_VERSION = 1 as const;
+
+export type Scene3DObjectKind = 'empty' | 'model' | 'primitive' | 'light' | 'camera';
+export type Scene3DPrimitive = 'box' | 'sphere' | 'plane' | 'cylinder';
+export type Scene3DLightKind = 'ambient' | 'directional' | 'point' | 'spot';
+
+export interface Scene3DVec3 {
+  readonly x: number;
+  readonly y: number;
+  readonly z: number;
+}
+export interface Scene3DTransform {
+  readonly position: Scene3DVec3;
+  readonly rotation: Scene3DVec3;
+  readonly scale: Scene3DVec3;
+}
+export interface Scene3DMaterial {
+  readonly id: string;
+  readonly color: string;
+  readonly roughness: number;
+  readonly metalness: number;
+  readonly opacity?: number;
+}
+export interface Scene3DObject {
+  readonly id: string;
+  readonly name: string;
+  readonly kind: Scene3DObjectKind;
+  readonly parentId?: string;
+  readonly transform: Scene3DTransform;
+  readonly assetId?: string;
+  readonly primitive?: Scene3DPrimitive;
+  readonly materialId?: string;
+  readonly light?: {
+    readonly kind: Scene3DLightKind;
+    readonly intensity: number;
+    readonly color: string;
+  };
+  readonly camera?: {
+    readonly fieldOfViewDeg: number;
+    readonly near: number;
+    readonly far: number;
+  };
+}
+export interface Scene3DAssetRef {
+  readonly id: string;
+  readonly kind: 'model';
+  readonly mimeType: 'model/gltf-binary' | 'model/gltf+json';
+  readonly sha256?: string;
+}
+export interface Scene3DEnvironment {
+  readonly backgroundColor: string;
+  readonly ambientIntensity: number;
+}
+export interface Scene3DDocumentV1 {
+  readonly schemaVersion: typeof SCENE3D_SCHEMA_VERSION;
+  readonly id: string;
+  readonly name: string;
+  readonly durationUs: number;
+  readonly objects: Readonly<Record<string, Scene3DObject>>;
+  readonly assets: Readonly<Record<string, Scene3DAssetRef>>;
+  readonly materials: Readonly<Record<string, Scene3DMaterial>>;
+  readonly environment: Scene3DEnvironment;
+  readonly activeCameraId?: string;
+}
+
+export const IDENTITY_3D_TRANSFORM: Scene3DTransform = {
+  position: { x: 0, y: 0, z: 0 },
+  rotation: { x: 0, y: 0, z: 0 },
+  scale: { x: 1, y: 1, z: 1 },
+};
+
+export function emptyScene3D(id: string, name = 'Untitled 3D scene'): Scene3DDocumentV1 {
+  return {
+    schemaVersion: SCENE3D_SCHEMA_VERSION,
+    id,
+    name,
+    durationUs: 5_000_000,
+    objects: {},
+    assets: {},
+    materials: {},
+    environment: { backgroundColor: '#10131a', ambientIntensity: 0.5 },
+  };
+}
+
+/** Upgrade the short-lived v0 JSON shape used by the initial 3D spike. */
+export function migrateScene3DDocument(input: unknown): Scene3DDocumentV1 {
+  if (!isRecord(input)) throw new TypeError('scene JSON must be an object');
+  if (input.schemaVersion === SCENE3D_SCHEMA_VERSION) return input as unknown as Scene3DDocumentV1;
+  if (input.schemaVersion !== 0) throw new TypeError('unsupported scene schema version');
+  const scene = emptyScene3D(
+    typeof input.sceneId === 'string' ? input.sceneId : typeof input.id === 'string' ? input.id : 'scene-migrated',
+    typeof input.title === 'string' ? input.title : typeof input.name === 'string' ? input.name : undefined,
+  );
+  const legacyObjects = isRecord(input.objects) ? input.objects : {};
+  const objects: Record<string, Scene3DObject> = {};
+  for (const [id, value] of Object.entries(legacyObjects)) {
+    if (!isRecord(value)) continue;
+    const transform = isRecord(value.transform) ? value.transform : IDENTITY_3D_TRANSFORM;
+    objects[id] = {
+      id,
+      name: typeof value.name === 'string' ? value.name : id,
+      kind: value.kind === 'model' || value.kind === 'primitive' || value.kind === 'light' || value.kind === 'camera' ? value.kind : 'empty',
+      transform: normalizeTransform(transform),
+      ...(typeof value.parentId === 'string' ? { parentId: value.parentId } : {}),
+      ...(typeof value.assetId === 'string' ? { assetId: value.assetId } : {}),
+    };
+  }
+  const durationUs = typeof input.durationUs === 'number' && Number.isSafeInteger(input.durationUs) && input.durationUs >= 0
+    ? input.durationUs
+    : scene.durationUs;
+  return { ...scene, durationUs, objects };
+}
+
+export function parseScene3DDocument(json: string): Scene3DDocumentV1 {
+  return migrateScene3DDocument(JSON.parse(json) as unknown);
+}
+
+function normalizeTransform(value: Record<string, any>): Scene3DTransform {
+  const vector = (candidate: unknown, fallback: Scene3DVec3): Scene3DVec3 => {
+    if (!isRecord(candidate)) return fallback;
+    return {
+      x: typeof candidate.x === 'number' && Number.isFinite(candidate.x) ? candidate.x : fallback.x,
+      y: typeof candidate.y === 'number' && Number.isFinite(candidate.y) ? candidate.y : fallback.y,
+      z: typeof candidate.z === 'number' && Number.isFinite(candidate.z) ? candidate.z : fallback.z,
+    };
+  };
+  return {
+    position: vector(value.position, IDENTITY_3D_TRANSFORM.position),
+    rotation: vector(value.rotation, IDENTITY_3D_TRANSFORM.rotation),
+    scale: vector(value.scale, IDENTITY_3D_TRANSFORM.scale),
+  };
+}
+
+function isRecord(value: unknown): value is Record<string, any> {
+  return value !== null && typeof value === 'object' && !Array.isArray(value);
+}
diff --git a/packages/scene3d-core/src/validation.test.ts b/packages/scene3d-core/src/validation.test.ts
new file mode 100644
index 0000000..acbd6e3
--- /dev/null
+++ b/packages/scene3d-core/src/validation.test.ts
@@ -0,0 +1,71 @@
+import { describe, expect, it } from 'vitest';
+import { emptyScene3D, IDENTITY_3D_TRANSFORM, type Scene3DObject } from './scene.js';
+import { validateScene3DDocument } from './validation.js';
+
+const object = (overrides: Partial<Scene3DObject> = {}): Scene3DObject => ({
+  id: 'model',
+  name: 'Model',
+  kind: 'model',
+  assetId: 'asset',
+  transform: IDENTITY_3D_TRANSFORM,
+  ...overrides,
+});
+
+describe('scene3d validation', () => {
+  it('rejects missing model assets and invalid transforms', () => {
+    const scene = {
+      ...emptyScene3D('s'),
+      objects: {
+        model: object({ transform: { ...IDENTITY_3D_TRANSFORM, scale: { x: 0, y: 1, z: 1 } } }),
+      },
+    };
+    const errors = validateScene3DDocument(scene);
+    expect(errors.map((error) => error.code)).toEqual(
+      expect.arrayContaining(['missing-asset', 'transform-scale']),
+    );
+  });
+
+  it('rejects hierarchy cycles, invalid active camera, and missing material', () => {
+    const scene = {
+      ...emptyScene3D('s'),
+      objects: {
+        a: object({ id: 'a', parentId: 'b', materialId: 'missing' }),
+        b: object({ id: 'b', parentId: 'a' }),
+      },
+      activeCameraId: 'a',
+    };
+    const codes = validateScene3DDocument(scene).map((error) => error.code);
+    expect(codes).toEqual(expect.arrayContaining(['cycle', 'active-camera', 'missing-material']));
+  });
+
+  it('rejects malformed payloads without throwing', () => {
+    const errors = validateScene3DDocument({
+      schemaVersion: 1,
+      id: 's',
+      name: 'Malformed',
+      durationUs: 1,
+      objects: {
+        camera: {
+          id: 'camera',
+          name: 'Camera',
+          kind: 'camera',
+          transform: IDENTITY_3D_TRANSFORM,
+          camera: { fieldOfViewDeg: 50, near: Number.NaN, far: Number.POSITIVE_INFINITY },
+        },
+        light: {
+          id: 'light',
+          name: 'Light',
+          kind: 'light',
+          transform: IDENTITY_3D_TRANSFORM,
+          light: { kind: 'unknown', intensity: Number.NaN, color: 'bad' },
+        },
+      },
+      assets: { bad: { id: 'bad', kind: 'model', mimeType: 'text/plain' } },
+      materials: {},
+      environment: { backgroundColor: '#000000', ambientIntensity: 0.5 },
+    });
+    expect(errors.map((error) => error.code)).toEqual(
+      expect.arrayContaining(['camera', 'light', 'asset-ref']),
+    );
+  });
+});
diff --git a/packages/scene3d-core/src/validation.ts b/packages/scene3d-core/src/validation.ts
new file mode 100644
index 0000000..c204132
--- /dev/null
+++ b/packages/scene3d-core/src/validation.ts
@@ -0,0 +1,152 @@
+import type {
+  Scene3DAssetRef,
+  Scene3DDocumentV1,
+  Scene3DEnvironment,
+  Scene3DObject,
+  Scene3DTransform,
+} from './scene.js';
+
+export interface Scene3DValidationError {
+  readonly code: string;
+  readonly path: string;
+  readonly message: string;
+}
+
+/** Runtime validation accepts unknown JSON so malformed persisted data never throws while walking. */
+export function validateScene3DDocument(document: unknown): readonly Scene3DValidationError[] {
+  const errors: Scene3DValidationError[] = [];
+  if (!isRecord(document))
+    return [{ code: 'document', path: '', message: 'scene document must be an object' }];
+  if (document.schemaVersion !== 1)
+    errors.push({ code: 'schema-version', path: 'schemaVersion', message: 'scene schema version must be 1' });
+  if (!nonEmpty(document.id)) errors.push({ code: 'id', path: 'id', message: 'scene id is required' });
+  if (!nonEmpty(document.name)) errors.push({ code: 'name', path: 'name', message: 'scene name is required' });
+  if (!Number.isSafeInteger(document.durationUs) || document.durationUs < 0)
+    errors.push({ code: 'duration', path: 'durationUs', message: 'durationUs must be a non-negative integer' });
+
+  const objects = recordValue(document.objects);
+  const assets = recordValue(document.assets);
+  const materials = recordValue(document.materials);
+  if (objects === undefined) errors.push({ code: 'objects', path: 'objects', message: 'objects must be a record' });
+  if (assets === undefined) errors.push({ code: 'assets', path: 'assets', message: 'assets must be a record' });
+  if (materials === undefined) errors.push({ code: 'materials', path: 'materials', message: 'materials must be a record' });
+  if (!isEnvironment(document.environment))
+    errors.push({ code: 'environment', path: 'environment', message: 'environment values are invalid' });
+
+  if (assets !== undefined)
+    for (const [id, rawAsset] of Object.entries(assets)) validateAsset(id, rawAsset, errors);
+  if (objects !== undefined)
+    for (const [id, rawObject] of Object.entries(objects))
+      validateObject(objects, assets, materials, id, rawObject, errors);
+  if (materials !== undefined) {
+    for (const [id, rawMaterial] of Object.entries(materials)) {
+      if (!isRecord(rawMaterial)) {
+        errors.push({ code: 'material-shape', path: `materials.${id}`, message: 'material must be an object' });
+        continue;
+      }
+      if (id !== rawMaterial.id || !nonEmpty(id))
+        errors.push({ code: 'material-id', path: `materials.${id}`, message: 'material id must match its key' });
+      if (!isColor(rawMaterial.color))
+        errors.push({ code: 'material-color', path: `materials.${id}.color`, message: 'material color must be #RRGGBB' });
+      if (!range(rawMaterial.roughness, 0, 1) || !range(rawMaterial.metalness, 0, 1) ||
+          (rawMaterial.opacity !== undefined && !range(rawMaterial.opacity, 0, 1)))
+        errors.push({ code: 'material-range', path: `materials.${id}`, message: 'material channels must be between 0 and 1' });
+    }
+  }
+  const activeCamera = typeof document.activeCameraId === 'string' ? objects?.[document.activeCameraId] : undefined;
+  if (document.activeCameraId !== undefined && (!isRecord(activeCamera) || activeCamera.kind !== 'camera'))
+    errors.push({ code: 'active-camera', path: 'activeCameraId', message: 'active camera must reference a camera object' });
+  return errors;
+}
+
+export function assertValidScene3DDocument(document: unknown): asserts document is Scene3DDocumentV1 {
+  const errors = validateScene3DDocument(document);
+  if (errors.length > 0) throw new RangeError(`scene document is invalid: ${errors[0]!.message}`);
+}
+
+function validateAsset(id: string, rawAsset: unknown, errors: Scene3DValidationError[]): rawAsset is Scene3DAssetRef {
+  if (!isRecord(rawAsset)) {
+    errors.push({ code: 'asset-shape', path: `assets.${id}`, message: 'asset must be an object' });
+    return false;
+  }
+  if (id !== rawAsset.id || rawAsset.kind !== 'model' ||
+      (rawAsset.mimeType !== 'model/gltf-binary' && rawAsset.mimeType !== 'model/gltf+json'))
+    errors.push({ code: 'asset-ref', path: `assets.${id}`, message: 'asset id, kind, or MIME type is invalid' });
+  if (rawAsset.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(String(rawAsset.sha256)))
+    errors.push({ code: 'asset-hash', path: `assets.${id}.sha256`, message: 'asset sha256 must be a lowercase SHA-256 digest' });
+  return true;
+}
+
+function validateObject(
+  objects: Record<string, unknown>,
+  assets: Record<string, unknown> | undefined,
+  materials: Record<string, unknown> | undefined,
+  id: string,
+  rawObject: unknown,
+  errors: Scene3DValidationError[],
+): rawObject is Scene3DObject {
+  if (!isRecord(rawObject)) {
+    errors.push({ code: 'object-shape', path: `objects.${id}`, message: 'object must be an object' });
+    return false;
+  }
+  if (id !== rawObject.id || !nonEmpty(rawObject.name) || !isObjectKind(rawObject.kind))
+    errors.push({ code: 'object-id', path: `objects.${id}`, message: 'object id/name/kind is invalid' });
+  if (rawObject.parentId !== undefined && (typeof rawObject.parentId !== 'string' || objects[rawObject.parentId] === undefined))
+    errors.push({ code: 'missing-parent', path: `objects.${id}.parentId`, message: 'parent object does not exist' });
+  validateTransform(rawObject.transform, `objects.${id}.transform`, errors);
+  if (rawObject.kind === 'primitive' && !isPrimitive(rawObject.primitive))
+    errors.push({ code: 'primitive', path: `objects.${id}`, message: 'primitive payload is invalid' });
+  if (rawObject.kind === 'light') {
+    const light = rawObject.light;
+    if (!isRecord(light) || !isLightKind(light.kind) || !range(light.intensity, 0, Number.MAX_SAFE_INTEGER) || !isColor(light.color))
+      errors.push({ code: 'light', path: `objects.${id}`, message: 'light payload is invalid' });
+  }
+  if (rawObject.kind === 'camera') {
+    const camera = rawObject.camera;
+    if (!isRecord(camera) || !range(camera.fieldOfViewDeg, 1, 170) || !range(camera.near, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER) ||
+        !range(camera.far, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER) || camera.far <= camera.near)
+      errors.push({ code: 'camera', path: `objects.${id}`, message: 'camera payload is invalid' });
+  }
+  if (rawObject.kind === 'model' && (typeof rawObject.assetId !== 'string' || assets?.[rawObject.assetId] === undefined))
+    errors.push({ code: 'missing-asset', path: `objects.${id}.assetId`, message: 'model object must reference a registered model asset' });
+  if (rawObject.materialId !== undefined && (typeof rawObject.materialId !== 'string' || materials?.[rawObject.materialId] === undefined))
+    errors.push({ code: 'missing-material', path: `objects.${id}.materialId`, message: 'object references a missing material' });
+
+  const seen = new Set<string>();
+  let current: string | undefined = id;
+  while (current !== undefined) {
+    if (seen.has(current)) {
+      errors.push({ code: 'cycle', path: `objects.${id}.parentId`, message: 'object hierarchy contains a cycle' });
+      break;
+    }
+    seen.add(current);
+    const parent: unknown = objects[current];
+    current = isRecord(parent) && typeof parent.parentId === 'string' ? parent.parentId : undefined;
+  }
+  return true;
+}
+
+function validateTransform(transform: unknown, path: string, errors: Scene3DValidationError[]): transform is Scene3DTransform {
+  if (!isRecord(transform) || !isVec3(transform.position) || !isVec3(transform.rotation) || !isVec3(transform.scale)) {
+    errors.push({ code: 'transform-shape', path, message: 'transform must contain finite position, rotation, and scale vectors' });
+    return false;
+  }
+  if (transform.scale.x <= 0 || transform.scale.y <= 0 || transform.scale.z <= 0)
+    errors.push({ code: 'transform-scale', path, message: 'scale values must be positive' });
+  return true;
+}
+
+function isEnvironment(value: unknown): value is Scene3DEnvironment {
+  return isRecord(value) && isColor(value.backgroundColor) && range(value.ambientIntensity, 0, Number.MAX_SAFE_INTEGER);
+}
+function isVec3(value: unknown): value is { x: number; y: number; z: number } {
+  return isRecord(value) && ['x', 'y', 'z'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
+}
+function isColor(value: unknown): value is string { return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value); }
+function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
+function recordValue(value: unknown): Record<string, unknown> | undefined { return isRecord(value) ? value : undefined; }
+function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
+function range(value: unknown, min: number, max: number): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max; }
+function isObjectKind(value: unknown): value is Scene3DObject['kind'] { return value === 'empty' || value === 'model' || value === 'primitive' || value === 'light' || value === 'camera'; }
+function isPrimitive(value: unknown): boolean { return value === 'box' || value === 'sphere' || value === 'plane' || value === 'cylinder'; }
+function isLightKind(value: unknown): boolean { return value === 'ambient' || value === 'directional' || value === 'point' || value === 'spot'; }
diff --git a/packages/scene3d-core/tsconfig.json b/packages/scene3d-core/tsconfig.json
new file mode 100644
index 0000000..6fcd57f
--- /dev/null
+++ b/packages/scene3d-core/tsconfig.json
@@ -0,0 +1,5 @@
+{
+  "extends": "../../tsconfig.base.json",
+  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
+  "include": ["src"]
+}
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index e83a028..938aea7 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -459,20 +459,22 @@ importers:
       '@joy-media/transition-shaders':
         specifier: workspace:*
         version: link:../transition-shaders
       '@joy-media/visual-effects':
         specifier: workspace:*
         version: link:../visual-effects
       pixi.js:
         specifier: ^8.6.0
         version: 8.19.0
 
+  packages/scene3d-core: {}
+
   packages/test-fixtures:
     dependencies:
       '@joy-media/project-schema':
         specifier: workspace:*
         version: link:../project-schema
 
   packages/timeline-engine:
     dependencies:
       '@joy-media/commands':
         specifier: workspace:*
diff --git a/tsconfig.json b/tsconfig.json
index 1effac3..a66578b 100644
--- a/tsconfig.json
+++ b/tsconfig.json
@@ -1,17 +1,18 @@
 {
   "files": [],
   "references": [
     { "path": "tooling/release" },
     { "path": "packages/agent-tools" },
     { "path": "packages/captions-core" },
     { "path": "packages/motion-core" },
+    { "path": "packages/scene3d-core" },
     { "path": "packages/camera-core" },
     { "path": "packages/expression-core" },
     { "path": "packages/provider-sdk" },
     { "path": "packages/adapter-mistral" },
     { "path": "packages/production-quality" },
     { "path": "packages/export-core" },
     { "path": "packages/playback-engine" },
     { "path": "packages/property-system" },
     { "path": "packages/timeline-engine" },
     { "path": "apps/worker" },
diff --git a/vitest.config.ts b/vitest.config.ts
index b36f0dc..899bebe 100644
--- a/vitest.config.ts
+++ b/vitest.config.ts
@@ -41,20 +41,21 @@ export default defineConfig({
       '@joy-media/adapter-voice-isolation': pkg('./packages/adapter-voice-isolation/src/index.ts'),
       '@joy-media/adapter-tts': pkg('./packages/adapter-tts/src/index.ts'),
       '@joy-media/agent-tools': pkg('./packages/agent-tools/src/index.ts'),
       '@joy-media/camera-core': pkg('./packages/camera-core/src/index.ts'),
       '@joy-media/captions-core': pkg('./packages/captions-core/src/index.ts'),
       '@joy-media/collaboration-core': pkg('./packages/collaboration-core/src/index.ts'),
       '@joy-media/expression-core': pkg('./packages/expression-core/src/index.ts'),
       '@joy-media/golden-render': pkg('./tooling/golden-render/src/index.ts'),
       '@joy-media/job-protocol': pkg('./packages/job-protocol/src/index.ts'),
       '@joy-media/motion-core': pkg('./packages/motion-core/src/index.ts'),
+      '@joy-media/scene3d-core': pkg('./packages/scene3d-core/src/index.ts'),
       '@joy-media/playback-engine': pkg('./packages/playback-engine/src/index.ts'),
       '@joy-media/plugin-sdk/browser': pkg('./packages/plugin-sdk/src/browser.ts'),
       '@joy-media/plugin-sdk': pkg('./packages/plugin-sdk/src/index.ts'),
       '@joy-media/visual-object-renderer': pkg('./packages/visual-object-renderer/src/index.ts'),
       '@joy-media/visual-effects': pkg('./packages/visual-effects/src/index.ts'),
       '@joy-media/workflow-engine': pkg('./packages/workflow-engine/src/index.ts'),
       '@joy-media/worker': pkg('./apps/worker/src/index.ts'),
     },
   },
   test: {
