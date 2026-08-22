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
