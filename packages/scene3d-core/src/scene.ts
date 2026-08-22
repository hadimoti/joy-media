export const SCENE3D_SCHEMA_VERSION = 1 as const;

export type Scene3DObjectKind = 'empty' | 'model' | 'primitive' | 'light' | 'camera';
export type Scene3DPrimitive = 'box' | 'sphere' | 'plane' | 'cylinder';
export type Scene3DLightKind = 'ambient' | 'directional' | 'point' | 'spot';

export interface Scene3DVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}
export interface Scene3DTransform {
  readonly position: Scene3DVec3;
  readonly rotation: Scene3DVec3;
  readonly scale: Scene3DVec3;
}
export interface Scene3DMaterial {
  readonly id: string;
  readonly color: string;
  readonly roughness: number;
  readonly metalness: number;
  readonly opacity?: number;
}
export interface Scene3DObject {
  readonly id: string;
  readonly name: string;
  readonly kind: Scene3DObjectKind;
  readonly parentId?: string;
  readonly transform: Scene3DTransform;
  readonly assetId?: string;
  readonly primitive?: Scene3DPrimitive;
  readonly materialId?: string;
  readonly light?: {
    readonly kind: Scene3DLightKind;
    readonly intensity: number;
    readonly color: string;
  };
  readonly camera?: {
    readonly fieldOfViewDeg: number;
    readonly near: number;
    readonly far: number;
  };
}
export interface Scene3DAssetRef {
  readonly id: string;
  readonly kind: 'model';
  readonly mimeType: 'model/gltf-binary' | 'model/gltf+json';
  readonly sha256?: string;
}
export interface Scene3DEnvironment {
  readonly backgroundColor: string;
  readonly ambientIntensity: number;
}
export interface Scene3DDocumentV1 {
  readonly schemaVersion: typeof SCENE3D_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly durationUs: number;
  readonly objects: Readonly<Record<string, Scene3DObject>>;
  readonly assets: Readonly<Record<string, Scene3DAssetRef>>;
  readonly materials: Readonly<Record<string, Scene3DMaterial>>;
  readonly environment: Scene3DEnvironment;
  readonly activeCameraId?: string;
}

export const IDENTITY_3D_TRANSFORM: Scene3DTransform = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
};

export function emptyScene3D(id: string, name = 'Untitled 3D scene'): Scene3DDocumentV1 {
  return {
    schemaVersion: SCENE3D_SCHEMA_VERSION,
    id,
    name,
    durationUs: 5_000_000,
    objects: {},
    assets: {},
    materials: {},
    environment: { backgroundColor: '#10131a', ambientIntensity: 0.5 },
  };
}

/** Upgrade the short-lived v0 JSON shape used by the initial 3D spike. */
export function migrateScene3DDocument(input: unknown): Scene3DDocumentV1 {
  if (!isRecord(input)) throw new TypeError('scene JSON must be an object');
  if (input.schemaVersion === SCENE3D_SCHEMA_VERSION) return input as unknown as Scene3DDocumentV1;
  if (input.schemaVersion !== 0) throw new TypeError('unsupported scene schema version');
  const scene = emptyScene3D(
    typeof input.sceneId === 'string' ? input.sceneId : typeof input.id === 'string' ? input.id : 'scene-migrated',
    typeof input.title === 'string' ? input.title : typeof input.name === 'string' ? input.name : undefined,
  );
  const legacyObjects = isRecord(input.objects) ? input.objects : {};
  const objects: Record<string, Scene3DObject> = {};
  for (const [id, value] of Object.entries(legacyObjects)) {
    if (!isRecord(value)) continue;
    const transform = isRecord(value.transform) ? value.transform : IDENTITY_3D_TRANSFORM;
    objects[id] = {
      id,
      name: typeof value.name === 'string' ? value.name : id,
      kind: value.kind === 'model' || value.kind === 'primitive' || value.kind === 'light' || value.kind === 'camera' ? value.kind : 'empty',
      transform: normalizeTransform(transform),
      ...(typeof value.parentId === 'string' ? { parentId: value.parentId } : {}),
      ...(typeof value.assetId === 'string' ? { assetId: value.assetId } : {}),
    };
  }
  const durationUs = typeof input.durationUs === 'number' && Number.isSafeInteger(input.durationUs) && input.durationUs >= 0
    ? input.durationUs
    : scene.durationUs;
  return { ...scene, durationUs, objects };
}

export function parseScene3DDocument(json: string): Scene3DDocumentV1 {
  return migrateScene3DDocument(JSON.parse(json) as unknown);
}

function normalizeTransform(value: Record<string, any>): Scene3DTransform {
  const vector = (candidate: unknown, fallback: Scene3DVec3): Scene3DVec3 => {
    if (!isRecord(candidate)) return fallback;
    return {
      x: typeof candidate.x === 'number' && Number.isFinite(candidate.x) ? candidate.x : fallback.x,
      y: typeof candidate.y === 'number' && Number.isFinite(candidate.y) ? candidate.y : fallback.y,
      z: typeof candidate.z === 'number' && Number.isFinite(candidate.z) ? candidate.z : fallback.z,
    };
  };
  return {
    position: vector(value.position, IDENTITY_3D_TRANSFORM.position),
    rotation: vector(value.rotation, IDENTITY_3D_TRANSFORM.rotation),
    scale: vector(value.scale, IDENTITY_3D_TRANSFORM.scale),
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
