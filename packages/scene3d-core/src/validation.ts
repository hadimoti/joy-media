import type { Scene3DDocumentV1, Scene3DObject, Scene3DTransform } from './scene.js';

export interface Scene3DValidationError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export function validateScene3DDocument(
  document: Scene3DDocumentV1,
): readonly Scene3DValidationError[] {
  const errors: Scene3DValidationError[] = [];
  if (document.schemaVersion !== 1)
    errors.push({
      code: 'schema-version',
      path: 'schemaVersion',
      message: 'scene schema version must be 1',
    });
  if (!nonEmpty(document.id))
    errors.push({ code: 'id', path: 'id', message: 'scene id is required' });
  if (!nonEmpty(document.name))
    errors.push({ code: 'name', path: 'name', message: 'scene name is required' });
  if (!Number.isSafeInteger(document.durationUs) || document.durationUs < 0)
    errors.push({
      code: 'duration',
      path: 'durationUs',
      message: 'durationUs must be a non-negative integer',
    });
  for (const [id, object] of Object.entries(document.objects))
    validateObject(document, id, object, errors);
  for (const [id, material] of Object.entries(document.materials)) {
    if (id !== material.id || !nonEmpty(id))
      errors.push({
        code: 'material-id',
        path: `materials.${id}`,
        message: 'material id must match its key',
      });
    if (!/^#[0-9a-f]{6}$/i.test(material.color))
      errors.push({
        code: 'material-color',
        path: `materials.${id}.color`,
        message: 'material color must be #RRGGBB',
      });
    if (
      !range(material.roughness, 0, 1) ||
      !range(material.metalness, 0, 1) ||
      (material.opacity !== undefined && !range(material.opacity, 0, 1))
    )
      errors.push({
        code: 'material-range',
        path: `materials.${id}`,
        message: 'material channels must be between 0 and 1',
      });
  }
  if (
    !/^#[0-9a-f]{6}$/i.test(document.environment.backgroundColor) ||
    !Number.isFinite(document.environment.ambientIntensity) ||
    document.environment.ambientIntensity < 0
  )
    errors.push({
      code: 'environment',
      path: 'environment',
      message: 'environment values are invalid',
    });
  if (
    document.activeCameraId !== undefined &&
    document.objects[document.activeCameraId]?.kind !== 'camera'
  )
    errors.push({
      code: 'active-camera',
      path: 'activeCameraId',
      message: 'active camera must reference a camera object',
    });
  for (const [id, object] of Object.entries(document.objects)) {
    if (object.kind === 'model') {
      if (object.assetId === undefined || document.assets[object.assetId] === undefined)
        errors.push({
          code: 'missing-asset',
          path: `objects.${id}.assetId`,
          message: 'model object must reference a registered model asset',
        });
    }
    if (object.materialId !== undefined && document.materials[object.materialId] === undefined)
      errors.push({
        code: 'missing-material',
        path: `objects.${id}.materialId`,
        message: 'object references a missing material',
      });
  }
  return errors;
}

function validateObject(
  document: Scene3DDocumentV1,
  id: string,
  object: Scene3DObject,
  errors: Scene3DValidationError[],
): void {
  if (id !== object.id || !nonEmpty(object.name))
    errors.push({ code: 'object-id', path: `objects.${id}`, message: 'object id/name is invalid' });
  if (object.parentId !== undefined && document.objects[object.parentId] === undefined)
    errors.push({
      code: 'missing-parent',
      path: `objects.${id}.parentId`,
      message: 'parent object does not exist',
    });
  validateTransform(object.transform, `objects.${id}.transform`, errors);
  if (object.kind === 'primitive' && object.primitive === undefined)
    errors.push({
      code: 'primitive',
      path: `objects.${id}`,
      message: 'primitive object needs a primitive payload',
    });
  if (object.kind === 'light' && (object.light === undefined || object.light.intensity < 0))
    errors.push({ code: 'light', path: `objects.${id}`, message: 'light payload is invalid' });
  if (
    object.kind === 'camera' &&
    (object.camera === undefined ||
      !range(object.camera.fieldOfViewDeg, 1, 170) ||
      object.camera.near <= 0 ||
      object.camera.far <= object.camera.near)
  )
    errors.push({ code: 'camera', path: `objects.${id}`, message: 'camera payload is invalid' });
  const seen = new Set<string>();
  let current: string | undefined = id;
  while (current !== undefined) {
    if (seen.has(current)) {
      errors.push({
        code: 'cycle',
        path: `objects.${id}.parentId`,
        message: 'object hierarchy contains a cycle',
      });
      break;
    }
    seen.add(current);
    current = document.objects[current]?.parentId;
  }
}

function validateTransform(
  transform: Scene3DTransform,
  path: string,
  errors: Scene3DValidationError[],
): void {
  const values = [
    ...Object.values(transform.position),
    ...Object.values(transform.rotation),
    ...Object.values(transform.scale),
  ];
  if (!values.every(Number.isFinite))
    errors.push({ code: 'transform-finite', path, message: 'transform values must be finite' });
  if (transform.scale.x <= 0 || transform.scale.y <= 0 || transform.scale.z <= 0)
    errors.push({ code: 'transform-scale', path, message: 'scale values must be positive' });
}
const nonEmpty = (value: string): boolean => typeof value === 'string' && value.trim().length > 0;
const range = (value: number, min: number, max: number): boolean =>
  Number.isFinite(value) && value >= min && value <= max;
