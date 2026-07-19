import type {
  JoyProjectV1,
  VisualObjectTransformV1,
  VisualObjectV1,
} from '@joy-media/project-schema';

export type ObjectKind = VisualObjectV1['kind'];
export type TransformProperties = VisualObjectTransformV1;
export type VisualObject = VisualObjectV1;
export interface PropertyDescriptor {
  readonly key: keyof TransformProperties;
  readonly label: string;
  readonly kind: 'number' | 'crop';
  readonly min?: number;
  readonly max?: number;
  readonly multiEditPolicy: 'shared' | 'relative';
}
export const VISUAL_INSPECTOR: readonly PropertyDescriptor[] = [
  { key: 'x', label: 'Position X', kind: 'number', multiEditPolicy: 'relative' },
  { key: 'y', label: 'Position Y', kind: 'number', multiEditPolicy: 'relative' },
  { key: 'scaleX', label: 'Scale X', kind: 'number', min: 0.001, multiEditPolicy: 'relative' },
  { key: 'scaleY', label: 'Scale Y', kind: 'number', min: 0.001, multiEditPolicy: 'relative' },
  { key: 'rotationDeg', label: 'Rotation', kind: 'number', multiEditPolicy: 'relative' },
  { key: 'opacity', label: 'Opacity', kind: 'number', min: 0, max: 1, multiEditPolicy: 'shared' },
  { key: 'crop', label: 'Crop', kind: 'crop', multiEditPolicy: 'relative' },
];
export function sharedValue<T>(values: readonly T[]): T | undefined {
  return values.length > 0 && values.every((value) => Object.is(value, values[0]))
    ? values[0]
    : undefined;
}

export function setVisualProperty(
  objects: readonly VisualObject[],
  ids: readonly string[],
  key: Exclude<keyof TransformProperties, 'crop'>,
  value: number,
): readonly VisualObject[] {
  if (!Number.isFinite(value)) throw new RangeError(`property ${key} must be finite`);
  if (key === 'opacity' && (value < 0 || value > 1))
    throw new RangeError('opacity must be in [0, 1]');
  if ((key === 'scaleX' || key === 'scaleY') && value <= 0)
    throw new RangeError('scale must be positive');
  const selected = new Set(ids);
  return objects.map((object) =>
    selected.has(object.id)
      ? { ...object, transform: { ...object.transform, [key]: value } }
      : object,
  );
}

export type VisualObjectCommand = {
  readonly type: 'object.setTransformProperty';
  readonly payload: {
    readonly objectId: string;
    readonly key: Exclude<keyof TransformProperties, 'crop'>;
    readonly value: number;
  };
};
export interface VisualObjectApplyResult {
  readonly objects: readonly VisualObject[];
  readonly inverse: VisualObjectCommand;
}

export interface VisualObjectProjectApplyResult {
  readonly project: JoyProjectV1;
  readonly inverse: VisualObjectCommand;
}

/** Applies a visual-object command to the durable v1 project document. */
export function applyVisualObjectProjectCommand(
  project: JoyProjectV1,
  command: VisualObjectCommand,
): VisualObjectProjectApplyResult {
  const object = project.visualObjects[command.payload.objectId];
  if (object === undefined)
    throw new RangeError(`unknown visual object ${command.payload.objectId}`);
  const applied = applyVisualObjectCommand([object], command);
  return {
    project: {
      ...project,
      visualObjects: { ...project.visualObjects, [object.id]: applied.objects[0]! },
    },
    inverse: applied.inverse,
  };
}

/** Applies an all-or-nothing transaction to the durable v1 project document. */
export function applyVisualObjectProjectTransaction(
  project: JoyProjectV1,
  transaction: VisualObjectTransaction,
): JoyProjectV1 {
  if (transaction.commands.length === 0) throw new RangeError('object transaction cannot be empty');
  let next = project;
  for (const command of transaction.commands)
    next = applyVisualObjectProjectCommand(next, command).project;
  return next;
}
/** Durable object mutation with an inverse captured from pre-state. */
export function applyVisualObjectCommand(
  objects: readonly VisualObject[],
  command: VisualObjectCommand,
): VisualObjectApplyResult {
  const object = objects.find((item) => item.id === command.payload.objectId);
  if (object === undefined)
    throw new RangeError(`unknown visual object ${command.payload.objectId}`);
  const previous = object.transform[command.payload.key];
  return {
    objects: setVisualProperty(objects, [object.id], command.payload.key, command.payload.value),
    inverse: {
      type: 'object.setTransformProperty',
      payload: { objectId: object.id, key: command.payload.key, value: previous },
    },
  };
}

export interface VisualObjectProject {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly objects: readonly VisualObject[];
}
export interface VisualObjectTransaction {
  readonly label: string;
  readonly commands: readonly VisualObjectCommand[];
}
export function applyVisualObjectTransaction(
  project: VisualObjectProject,
  transaction: VisualObjectTransaction,
): VisualObjectProject {
  if (transaction.commands.length === 0) throw new RangeError('object transaction cannot be empty');
  let objects = project.objects;
  for (const command of transaction.commands)
    objects = applyVisualObjectCommand(objects, command).objects;
  return { ...project, objects };
}
export function validateVisualObjectProject(
  project: VisualObjectProject,
): readonly { readonly code: string; readonly message: string }[] {
  if (project.id.length === 0)
    return [{ code: 'OBJECT_PROJECT_ID', message: 'project id is required' }];
  if (new Set(project.objects.map((object) => object.id)).size !== project.objects.length)
    return [{ code: 'OBJECT_PROJECT_DUPLICATE', message: 'object ids must be unique' }];
  return [];
}
