import type {
  JoyProjectV1,
  MarkerV1,
  VisualObjectTransformV1,
  VisualObjectV1,
} from '@joy-media/project-schema';
import { applyCaptionProjectCommand } from '@joy-media/captions-core';
import type { CaptionCommand } from '@joy-media/captions-core';
import { applyMotionProjectCommand } from '@joy-media/motion-core';
import type { MotionCommand } from '@joy-media/motion-core';

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

export type NumericTransformProperty = Exclude<keyof TransformProperties, 'crop'>;
export type VisualObjectCommand =
  | {
      readonly type: 'object.setTransformProperty';
      readonly payload: {
        readonly objectId: string;
        readonly key: NumericTransformProperty;
        readonly value: number;
      };
    }
  | {
      readonly type: 'object.setCrop';
      readonly payload: { readonly objectId: string; readonly crop: TransformProperties['crop'] };
    }
  | { readonly type: 'marker.add'; readonly payload: { readonly marker: MarkerV1 } }
  | { readonly type: 'marker.remove'; readonly payload: { readonly markerId: string } }
  | {
      /** Sets or clears a composition's depth-only 2.5D camera (§20.3, ADR-0015). */
      readonly type: 'composition.setActiveCamera';
      readonly payload: { readonly compositionId: string; readonly cameraId?: string };
    }
  | {
      /** Adds a new `kind: 'camera'` object (ADR-0015, WP-10.2). */
      readonly type: 'camera.create';
      readonly payload: { readonly object: VisualObjectV1 };
    }
  | {
      /** Removes a camera object; rejected while it is still referenced (active camera or parent). */
      readonly type: 'camera.remove';
      readonly payload: { readonly objectId: string };
    }
  | {
      readonly type: 'camera.setFieldOfView';
      readonly payload: { readonly objectId: string; readonly fieldOfViewDeg: number };
    }
  | {
      /** Adds a `kind: 'html-scene'` object referencing a scene package (P04). */
      readonly type: 'htmlScene.create';
      readonly payload: { readonly object: VisualObjectV1 };
    }
  | {
      readonly type: 'htmlScene.remove';
      readonly payload: { readonly objectId: string };
    }
  | CaptionCommand
  | MotionCommand;
export interface VisualObjectApplyResult {
  readonly objects: readonly VisualObject[];
  readonly inverse: Extract<VisualObjectCommand, { readonly type: 'object.setTransformProperty' }>;
}

export interface VisualObjectProjectApplyResult {
  readonly project: JoyProjectV1;
  readonly inverse: VisualObjectCommand;
}

export interface VisualObjectTransactionRecord {
  readonly transaction: VisualObjectTransaction;
  /** Inverses are ordered for a direct undo replay. */
  readonly inverses: VisualObjectTransaction;
}

/** Applies a visual-object command to the durable v1 project document. */
export function applyVisualObjectProjectCommand(
  project: JoyProjectV1,
  command: VisualObjectCommand,
): VisualObjectProjectApplyResult {
  switch (command.type) {
    case 'caption.setSegmentText':
    case 'caption.setSegmentTiming':
    case 'caption.setWordTiming':
    case 'caption.addSegment':
    case 'caption.removeSegment':
    case 'caption.setStyle':
    case 'caption.replaceDocument':
      return applyCaptionProjectCommand(project, command);
    case 'object.replaceAnimation':
    case 'object.setParent':
    case 'object.setExpression':
      return applyMotionProjectCommand(project, command);
    default:
      break;
  }
  if (command.type === 'marker.add') {
    if (project.markers.some((marker) => marker.id === command.payload.marker.id))
      throw new RangeError(`marker "${command.payload.marker.id}" already exists`);
    return {
      project: { ...project, markers: [...project.markers, command.payload.marker] },
      inverse: { type: 'marker.remove', payload: { markerId: command.payload.marker.id } },
    };
  }
  if (command.type === 'marker.remove') {
    const marker = project.markers.find((item) => item.id === command.payload.markerId);
    if (marker === undefined) throw new RangeError(`unknown marker "${command.payload.markerId}"`);
    return {
      project: {
        ...project,
        markers: project.markers.filter((item) => item.id !== command.payload.markerId),
      },
      inverse: { type: 'marker.add', payload: { marker } },
    };
  }
  if (command.type === 'composition.setActiveCamera') {
    const { compositionId, cameraId } = command.payload;
    const composition = project.compositions[compositionId];
    if (composition === undefined) throw new RangeError(`unknown composition "${compositionId}"`);
    if (cameraId !== undefined) {
      const camera = project.visualObjects[cameraId];
      if (camera === undefined) throw new RangeError(`unknown camera "${cameraId}"`);
      if (camera.kind !== 'camera') throw new RangeError(`object "${cameraId}" is not a camera`);
    }
    const previous = composition.activeCameraId;
    const nextComposition = { ...composition };
    if (cameraId === undefined) delete nextComposition.activeCameraId;
    else nextComposition.activeCameraId = cameraId;
    return {
      project: {
        ...project,
        compositions: { ...project.compositions, [compositionId]: nextComposition },
      },
      inverse: {
        type: 'composition.setActiveCamera',
        payload: previous === undefined ? { compositionId } : { compositionId, cameraId: previous },
      },
    };
  }
  if (command.type === 'camera.create') {
    const { object } = command.payload;
    if (object.kind !== 'camera')
      throw new RangeError('camera.create requires a camera-kind object');
    if (project.visualObjects[object.id] !== undefined)
      throw new RangeError(`visual object "${object.id}" already exists`);
    return {
      project: {
        ...project,
        visualObjects: { ...project.visualObjects, [object.id]: object },
      },
      inverse: { type: 'camera.remove', payload: { objectId: object.id } },
    };
  }
  if (command.type === 'camera.remove') {
    const { objectId } = command.payload;
    const camera = project.visualObjects[objectId];
    if (camera === undefined) throw new RangeError(`unknown visual object "${objectId}"`);
    if (camera.kind !== 'camera') throw new RangeError(`object "${objectId}" is not a camera`);
    const activeIn = Object.values(project.compositions).find(
      (composition) => composition.activeCameraId === objectId,
    );
    if (activeIn !== undefined)
      throw new RangeError(
        `camera "${objectId}" is still the active camera of composition "${activeIn.id}"`,
      );
    const parentOf = Object.values(project.visualObjects).find(
      (candidate) => candidate.parentId === objectId,
    );
    if (parentOf !== undefined)
      throw new RangeError(`camera "${objectId}" is still the parent of "${parentOf.id}"`);
    const remaining = { ...project.visualObjects };
    delete remaining[objectId];
    return {
      project: { ...project, visualObjects: remaining },
      inverse: { type: 'camera.create', payload: { object: camera } },
    };
  }
  if (command.type === 'camera.setFieldOfView') {
    const { objectId, fieldOfViewDeg } = command.payload;
    const camera = project.visualObjects[objectId];
    if (camera === undefined) throw new RangeError(`unknown visual object "${objectId}"`);
    if (camera.kind !== 'camera' || camera.camera === undefined)
      throw new RangeError(`object "${objectId}" is not a camera`);
    if (!Number.isFinite(fieldOfViewDeg) || fieldOfViewDeg <= 0 || fieldOfViewDeg > 170)
      throw new RangeError('fieldOfViewDeg must be in (0, 170]');
    const previousFov = camera.camera.fieldOfViewDeg;
    return {
      project: {
        ...project,
        visualObjects: {
          ...project.visualObjects,
          [objectId]: { ...camera, camera: { fieldOfViewDeg } },
        },
      },
      inverse: {
        type: 'camera.setFieldOfView',
        payload: { objectId, fieldOfViewDeg: previousFov },
      },
    };
  }
  if (command.type === 'htmlScene.create') {
    const { object } = command.payload;
    if (object.kind !== 'html-scene')
      throw new RangeError('htmlScene.create requires an html-scene-kind object');
    if (typeof object.scenePackageId !== 'string' || object.scenePackageId.length === 0)
      throw new RangeError('htmlScene.create requires scenePackageId');
    if (project.visualObjects[object.id] !== undefined)
      throw new RangeError(`visual object "${object.id}" already exists`);
    return {
      project: {
        ...project,
        visualObjects: { ...project.visualObjects, [object.id]: object },
      },
      inverse: { type: 'htmlScene.remove', payload: { objectId: object.id } },
    };
  }
  if (command.type === 'htmlScene.remove') {
    const { objectId } = command.payload;
    const scene = project.visualObjects[objectId];
    if (scene === undefined) throw new RangeError(`unknown visual object "${objectId}"`);
    if (scene.kind !== 'html-scene') throw new RangeError(`object "${objectId}" is not an html-scene`);
    const parentOf = Object.values(project.visualObjects).find(
      (candidate) => candidate.parentId === objectId,
    );
    if (parentOf !== undefined)
      throw new RangeError(`html-scene "${objectId}" is still the parent of "${parentOf.id}"`);
    const remaining = { ...project.visualObjects };
    delete remaining[objectId];
    return {
      project: { ...project, visualObjects: remaining },
      inverse: { type: 'htmlScene.create', payload: { object: scene } },
    };
  }
  const object = project.visualObjects[command.payload.objectId];
  if (object === undefined)
    throw new RangeError(`unknown visual object ${command.payload.objectId}`);
  if (command.type === 'object.setCrop') {
    const crop = command.payload.crop;
    if (![crop.left, crop.top, crop.right, crop.bottom].every(Number.isFinite))
      throw new RangeError('crop edges must be finite');
    return {
      project: {
        ...project,
        visualObjects: {
          ...project.visualObjects,
          [object.id]: { ...object, transform: { ...object.transform, crop } },
        },
      },
      inverse: {
        type: 'object.setCrop',
        payload: { objectId: object.id, crop: object.transform.crop },
      },
    };
  }
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

/** Applies a durable transaction and captures its pre-state inverses for history. */
export function applyVisualObjectProjectTransactionWithRecord(
  project: JoyProjectV1,
  transaction: VisualObjectTransaction,
): { readonly project: JoyProjectV1; readonly record: VisualObjectTransactionRecord } {
  if (transaction.commands.length === 0) throw new RangeError('object transaction cannot be empty');
  let next = project;
  const inverses: VisualObjectCommand[] = [];
  for (const command of transaction.commands) {
    const result = applyVisualObjectProjectCommand(next, command);
    next = result.project;
    inverses.unshift(result.inverse);
  }
  return {
    project: next,
    record: {
      transaction,
      inverses: { label: `Undo ${transaction.label}`, commands: inverses },
    },
  };
}

/** Linear undo/redo for durable visual-object Inspector edits. */
export class VisualObjectProjectHistory {
  #present: JoyProjectV1;
  readonly #undo: VisualObjectTransactionRecord[] = [];
  readonly #redo: VisualObjectTransactionRecord[] = [];

  constructor(initial: JoyProjectV1) {
    this.#present = initial;
  }

  get present(): JoyProjectV1 {
    return this.#present;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  /** Label of the transaction that undo would revert. */
  get undoLabel(): string | undefined {
    return this.#undo[this.#undo.length - 1]?.transaction.label;
  }

  /** Label of the transaction that redo would re-apply. */
  get redoLabel(): string | undefined {
    return this.#redo[this.#redo.length - 1]?.transaction.label;
  }

  /** Returns a copy of the undo stack (newest first, most recent at index 0). */
  get undoRecords(): readonly VisualObjectTransactionRecord[] {
    return [...this.#undo].reverse();
  }

  /** Returns a copy of the redo stack (newest first, most recent at index 0). */
  get redoRecords(): readonly VisualObjectTransactionRecord[] {
    return [...this.#redo].reverse();
  }

  apply(transaction: VisualObjectTransaction): JoyProjectV1 {
    const result = applyVisualObjectProjectTransactionWithRecord(this.#present, transaction);
    this.#present = result.project;
    this.#undo.push(result.record);
    this.#redo.length = 0;
    return this.#present;
  }

  undo(): { readonly project: JoyProjectV1; readonly transaction: VisualObjectTransaction } {
    const record = this.#undo.pop();
    if (record === undefined) throw new RangeError('nothing to undo');
    this.#present = applyVisualObjectProjectTransaction(this.#present, record.inverses);
    this.#redo.push(record);
    return { project: this.#present, transaction: record.inverses };
  }

  redo(): { readonly project: JoyProjectV1; readonly transaction: VisualObjectTransaction } {
    const record = this.#redo.pop();
    if (record === undefined) throw new RangeError('nothing to redo');
    this.#present = applyVisualObjectProjectTransaction(this.#present, record.transaction);
    this.#undo.push(record);
    return { project: this.#present, transaction: record.transaction };
  }
}
/** Durable object mutation with an inverse captured from pre-state. */
export function applyVisualObjectCommand(
  objects: readonly VisualObject[],
  command: Extract<VisualObjectCommand, { readonly type: 'object.setTransformProperty' }>,
): VisualObjectApplyResult {
  const object = objects.find((item) => item.id === command.payload.objectId);
  if (object === undefined)
    throw new RangeError(`unknown visual object ${command.payload.objectId}`);
  // positionZ is optional (default 0, ADR-0015); every other channel is always present.
  const previous = object.transform[command.payload.key] ?? 0;
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
  for (const command of transaction.commands) {
    if (command.type !== 'object.setTransformProperty')
      throw new RangeError('legacy object collections support numeric transform commands only');
    objects = applyVisualObjectCommand(objects, command).objects;
  }
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
