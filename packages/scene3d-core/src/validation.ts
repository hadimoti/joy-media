import type {
  Scene3DAssetRef,
  Scene3DDocumentV1,
  Scene3DEnvironment,
  Scene3DObject,
  Scene3DTransform,
} from './scene.js';

export interface Scene3DValidationError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** Runtime validation accepts unknown JSON so malformed persisted data never throws while walking. */
export function validateScene3DDocument(document: unknown): readonly Scene3DValidationError[] {
  const errors: Scene3DValidationError[] = [];
  if (!isRecord(document))
    return [{ code: 'document', path: '', message: 'scene document must be an object' }];
  if (document.schemaVersion !== 1)
    errors.push({ code: 'schema-version', path: 'schemaVersion', message: 'scene schema version must be 1' });
  if (!nonEmpty(document.id)) errors.push({ code: 'id', path: 'id', message: 'scene id is required' });
  if (!nonEmpty(document.name)) errors.push({ code: 'name', path: 'name', message: 'scene name is required' });
  if (!Number.isSafeInteger(document.durationUs) || document.durationUs < 0)
    errors.push({ code: 'duration', path: 'durationUs', message: 'durationUs must be a non-negative integer' });

  const objects = recordValue(document.objects);
  const assets = recordValue(document.assets);
  const materials = recordValue(document.materials);
  if (objects === undefined) errors.push({ code: 'objects', path: 'objects', message: 'objects must be a record' });
  if (assets === undefined) errors.push({ code: 'assets', path: 'assets', message: 'assets must be a record' });
  if (materials === undefined) errors.push({ code: 'materials', path: 'materials', message: 'materials must be a record' });
  if (!isEnvironment(document.environment))
    errors.push({ code: 'environment', path: 'environment', message: 'environment values are invalid' });

  if (assets !== undefined)
    for (const [id, rawAsset] of Object.entries(assets)) validateAsset(id, rawAsset, errors);
  if (objects !== undefined)
    for (const [id, rawObject] of Object.entries(objects))
      validateObject(objects, assets, materials, id, rawObject, errors);
  if (materials !== undefined) {
    for (const [id, rawMaterial] of Object.entries(materials)) {
      if (!isRecord(rawMaterial)) {
        errors.push({ code: 'material-shape', path: `materials.${id}`, message: 'material must be an object' });
        continue;
      }
      if (id !== rawMaterial.id || !nonEmpty(id))
        errors.push({ code: 'material-id', path: `materials.${id}`, message: 'material id must match its key' });
      if (!isColor(rawMaterial.color))
        errors.push({ code: 'material-color', path: `materials.${id}.color`, message: 'material color must be #RRGGBB' });
      if (!range(rawMaterial.roughness, 0, 1) || !range(rawMaterial.metalness, 0, 1) ||
          (rawMaterial.opacity !== undefined && !range(rawMaterial.opacity, 0, 1)))
        errors.push({ code: 'material-range', path: `materials.${id}`, message: 'material channels must be between 0 and 1' });
    }
  }
  const activeCamera = typeof document.activeCameraId === 'string' ? objects?.[document.activeCameraId] : undefined;
  if (document.activeCameraId !== undefined && (!isRecord(activeCamera) || activeCamera.kind !== 'camera'))
    errors.push({ code: 'active-camera', path: 'activeCameraId', message: 'active camera must reference a camera object' });
  return errors;
}

export function assertValidScene3DDocument(document: unknown): asserts document is Scene3DDocumentV1 {
  const errors = validateScene3DDocument(document);
  if (errors.length > 0) throw new RangeError(`scene document is invalid: ${errors[0]!.message}`);
}

function validateAsset(id: string, rawAsset: unknown, errors: Scene3DValidationError[]): rawAsset is Scene3DAssetRef {
  if (!isRecord(rawAsset)) {
    errors.push({ code: 'asset-shape', path: `assets.${id}`, message: 'asset must be an object' });
    return false;
  }
  if (id !== rawAsset.id || rawAsset.kind !== 'model' ||
      (rawAsset.mimeType !== 'model/gltf-binary' && rawAsset.mimeType !== 'model/gltf+json'))
    errors.push({ code: 'asset-ref', path: `assets.${id}`, message: 'asset id, kind, or MIME type is invalid' });
  if (rawAsset.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(String(rawAsset.sha256)))
    errors.push({ code: 'asset-hash', path: `assets.${id}.sha256`, message: 'asset sha256 must be a lowercase SHA-256 digest' });
  return true;
}

function validateObject(
  objects: Record<string, unknown>,
  assets: Record<string, unknown> | undefined,
  materials: Record<string, unknown> | undefined,
  id: string,
  rawObject: unknown,
  errors: Scene3DValidationError[],
): rawObject is Scene3DObject {
  if (!isRecord(rawObject)) {
    errors.push({ code: 'object-shape', path: `objects.${id}`, message: 'object must be an object' });
    return false;
  }
  if (id !== rawObject.id || !nonEmpty(rawObject.name) || !isObjectKind(rawObject.kind))
    errors.push({ code: 'object-id', path: `objects.${id}`, message: 'object id/name/kind is invalid' });
  if (rawObject.parentId !== undefined && (typeof rawObject.parentId !== 'string' || objects[rawObject.parentId] === undefined))
    errors.push({ code: 'missing-parent', path: `objects.${id}.parentId`, message: 'parent object does not exist' });
  validateTransform(rawObject.transform, `objects.${id}.transform`, errors);
  if (rawObject.kind === 'primitive' && !isPrimitive(rawObject.primitive))
    errors.push({ code: 'primitive', path: `objects.${id}`, message: 'primitive payload is invalid' });
  if (rawObject.kind === 'light') {
    const light = rawObject.light;
    if (!isRecord(light) || !isLightKind(light.kind) || !range(light.intensity, 0, Number.MAX_SAFE_INTEGER) || !isColor(light.color))
      errors.push({ code: 'light', path: `objects.${id}`, message: 'light payload is invalid' });
  }
  if (rawObject.kind === 'camera') {
    const camera = rawObject.camera;
    if (!isRecord(camera) || !range(camera.fieldOfViewDeg, 1, 170) || !range(camera.near, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER) ||
        !range(camera.far, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER) || camera.far <= camera.near)
      errors.push({ code: 'camera', path: `objects.${id}`, message: 'camera payload is invalid' });
  }
  if (rawObject.kind === 'model' && (typeof rawObject.assetId !== 'string' || assets?.[rawObject.assetId] === undefined))
    errors.push({ code: 'missing-asset', path: `objects.${id}.assetId`, message: 'model object must reference a registered model asset' });
  if (rawObject.materialId !== undefined && (typeof rawObject.materialId !== 'string' || materials?.[rawObject.materialId] === undefined))
    errors.push({ code: 'missing-material', path: `objects.${id}.materialId`, message: 'object references a missing material' });

  const seen = new Set<string>();
  let current: string | undefined = id;
  while (current !== undefined) {
    if (seen.has(current)) {
      errors.push({ code: 'cycle', path: `objects.${id}.parentId`, message: 'object hierarchy contains a cycle' });
      break;
    }
    seen.add(current);
    const parent: unknown = objects[current];
    current = isRecord(parent) && typeof parent.parentId === 'string' ? parent.parentId : undefined;
  }
  return true;
}

function validateTransform(transform: unknown, path: string, errors: Scene3DValidationError[]): transform is Scene3DTransform {
  if (!isRecord(transform) || !isVec3(transform.position) || !isVec3(transform.rotation) || !isVec3(transform.scale)) {
    errors.push({ code: 'transform-shape', path, message: 'transform must contain finite position, rotation, and scale vectors' });
    return false;
  }
  if (transform.scale.x <= 0 || transform.scale.y <= 0 || transform.scale.z <= 0)
    errors.push({ code: 'transform-scale', path, message: 'scale values must be positive' });
  return true;
}

function isEnvironment(value: unknown): value is Scene3DEnvironment {
  return isRecord(value) && isColor(value.backgroundColor) && range(value.ambientIntensity, 0, Number.MAX_SAFE_INTEGER);
}
function isVec3(value: unknown): value is { x: number; y: number; z: number } {
  return isRecord(value) && ['x', 'y', 'z'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
}
function isColor(value: unknown): value is string { return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value); }
function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function recordValue(value: unknown): Record<string, unknown> | undefined { return isRecord(value) ? value : undefined; }
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function range(value: unknown, min: number, max: number): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max; }
function isObjectKind(value: unknown): value is Scene3DObject['kind'] { return value === 'empty' || value === 'model' || value === 'primitive' || value === 'light' || value === 'camera'; }
function isPrimitive(value: unknown): boolean { return value === 'box' || value === 'sphere' || value === 'plane' || value === 'cylinder'; }
function isLightKind(value: unknown): boolean { return value === 'ambient' || value === 'directional' || value === 'point' || value === 'spot'; }
