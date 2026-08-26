import { applyCaptionProjectCommand } from '@joy-media/captions-core';
import { applyMotionProjectCommand } from '../../../packages/motion-core/src/commands.js';
import type { JoyProjectV1, VisualObjectV1 } from '@joy-media/project-schema';
import type { VisualObjectCommand, VisualObjectTransaction } from '@joy-media/property-system';

type ApplyResult = { readonly project: JoyProjectV1; readonly inverse: VisualObjectCommand };

const motionCommandTypes = new Set([
  'object.replaceAnimation',
  'object.setParent',
  'object.setExpression',
  'object.setSpatialPath',
  'effect.add',
  'effect.remove',
  'effect.reorder',
  'effect.toggle',
  'effect.setParam',
  'effect.clearAll',
  'effect.replace',
]);

function setTransformProperty(project: JoyProjectV1, command: VisualObjectCommand): ApplyResult {
  const payload = command.payload as {
    objectId: string;
    key: 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotationDeg' | 'opacity';
    value: number;
  };
  const object = project.visualObjects[payload.objectId];
  if (object === undefined) throw new RangeError(`unknown visual object ${payload.objectId}`);
  if (!Number.isFinite(payload.value))
    throw new RangeError(`property ${payload.key} must be finite`);
  if ((payload.key === 'scaleX' || payload.key === 'scaleY') && payload.value <= 0)
    throw new RangeError('scale must be positive');
  if (payload.key === 'opacity' && (payload.value < 0 || payload.value > 1))
    throw new RangeError('opacity must be in [0, 1]');
  const previous = object.transform[payload.key] ?? 0;
  return {
    project: {
      ...project,
      visualObjects: {
        ...project.visualObjects,
        [object.id]: {
          ...object,
          transform: { ...object.transform, [payload.key]: payload.value },
        },
      },
    },
    inverse: {
      type: 'object.setTransformProperty',
      payload: { objectId: object.id, key: payload.key, value: previous },
    },
  } as ApplyResult;
}

function updateObject(
  project: JoyProjectV1,
  object: VisualObjectV1,
  inverse: VisualObjectCommand,
): ApplyResult {
  if (project.visualObjects[object.id] !== undefined)
    throw new RangeError(`visual object "${object.id}" already exists`);
  return {
    project: { ...project, visualObjects: { ...project.visualObjects, [object.id]: object } },
    inverse,
  };
}

function removeObject(
  project: JoyProjectV1,
  objectId: string,
  kind: VisualObjectV1['kind'],
  inverse: (object: VisualObjectV1) => VisualObjectCommand,
): ApplyResult {
  const object = project.visualObjects[objectId];
  if (object === undefined) throw new RangeError(`unknown visual object "${objectId}"`);
  if (object.kind !== kind) throw new RangeError(`object "${objectId}" is not a ${kind}`);
  if (Object.values(project.visualObjects).some((candidate) => candidate.parentId === objectId))
    throw new RangeError(`object "${objectId}" is still a parent`);
  const visualObjects = { ...project.visualObjects };
  delete visualObjects[objectId];
  return { project: { ...project, visualObjects }, inverse: inverse(object) };
}

/** Synchronous initial-shell command kernel. Optional editor surfaces stay out of this module. */
export function applyVisualObjectProjectTransaction(
  project: JoyProjectV1,
  transaction: VisualObjectTransaction,
): JoyProjectV1 {
  if (transaction.commands.length === 0) throw new RangeError('object transaction cannot be empty');
  let next = project;
  for (const command of transaction.commands) next = applyCommand(next, command).project;
  return next;
}

function applyCommand(project: JoyProjectV1, command: VisualObjectCommand): ApplyResult {
  if (command.type.startsWith('caption.')) {
    return applyCaptionProjectCommand(project, command as never) as ApplyResult;
  }
  if (motionCommandTypes.has(command.type)) {
    return applyMotionProjectCommand(project, command as never) as ApplyResult;
  }
  if (command.type === 'object.setTransformProperty') return setTransformProperty(project, command);
  if (command.type === 'object.setCrop') {
    const { objectId, crop } = command.payload;
    const object = project.visualObjects[objectId];
    if (object === undefined) throw new RangeError(`unknown visual object ${objectId}`);
    if (![crop.left, crop.top, crop.right, crop.bottom].every(Number.isFinite))
      throw new RangeError('crop edges must be finite');
    return {
      project: {
        ...project,
        visualObjects: {
          ...project.visualObjects,
          [objectId]: { ...object, transform: { ...object.transform, crop } },
        },
      },
      inverse: { type: 'object.setCrop', payload: { objectId, crop: object.transform.crop } },
    };
  }
  if (command.type === 'asset.registerGenerated') {
    const { asset } = command.payload;
    if (project.assets[asset.id] !== undefined)
      throw new RangeError(`asset "${asset.id}" already exists`);
    return {
      project: { ...project, assets: { ...project.assets, [asset.id]: asset } },
      inverse: { type: 'asset.unregisterGenerated', payload: { assetId: asset.id } },
    };
  }
  if (command.type === 'asset.unregisterGenerated') {
    const { assetId } = command.payload;
    const asset = project.assets[assetId];
    if (asset === undefined || asset.generationProvenance === undefined)
      throw new RangeError(`generated asset "${assetId}" is unavailable`);
    if (
      Object.values(project.visualObjects).some(
        (object) => object.kind === 'image' && object.assetId === assetId,
      )
    )
      throw new RangeError(`generated asset "${assetId}" is still referenced`);
    const assets = { ...project.assets };
    delete assets[assetId];
    return {
      project: { ...project, assets },
      inverse: {
        type: 'asset.registerGenerated',
        payload: {
          asset: asset as Extract<
            VisualObjectCommand,
            { type: 'asset.registerGenerated' }
          >['payload']['asset'],
        },
      },
    };
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
      project: { ...project, markers: project.markers.filter((item) => item.id !== marker.id) },
      inverse: { type: 'marker.add', payload: { marker } },
    };
  }
  if (command.type === 'composition.setActiveCamera') {
    const { compositionId, cameraId } = command.payload;
    const composition = project.compositions[compositionId];
    if (composition === undefined) throw new RangeError(`unknown composition "${compositionId}"`);
    if (cameraId !== undefined && project.visualObjects[cameraId]?.kind !== 'camera')
      throw new RangeError(`object "${cameraId}" is not a camera`);
    const next = { ...composition };
    if (cameraId === undefined) delete next.activeCameraId;
    else next.activeCameraId = cameraId;
    return {
      project: { ...project, compositions: { ...project.compositions, [compositionId]: next } },
      inverse:
        composition.activeCameraId === undefined
          ? { type: 'composition.setActiveCamera', payload: { compositionId } }
          : {
              type: 'composition.setActiveCamera',
              payload: { compositionId, cameraId: composition.activeCameraId },
            },
    };
  }
  if (command.type === 'camera.setFieldOfView') {
    const { objectId, fieldOfViewDeg } = command.payload;
    const object = project.visualObjects[objectId];
    if (object?.kind !== 'camera' || object.camera === undefined)
      throw new RangeError(`object "${objectId}" is not a camera`);
    if (!Number.isFinite(fieldOfViewDeg) || fieldOfViewDeg <= 0 || fieldOfViewDeg > 170)
      throw new RangeError('fieldOfViewDeg must be in (0, 170]');
    return {
      project: {
        ...project,
        visualObjects: {
          ...project.visualObjects,
          [objectId]: { ...object, camera: { fieldOfViewDeg } },
        },
      },
      inverse: {
        type: 'camera.setFieldOfView',
        payload: { objectId, fieldOfViewDeg: object.camera.fieldOfViewDeg },
      },
    };
  }
  if (
    command.type === 'camera.create' ||
    command.type === 'htmlScene.create' ||
    command.type === 'motionScene.create' ||
    command.type === 'image.create'
  ) {
    const object =
      command.type === 'camera.create' ? command.payload.object : command.payload.object;
    return updateObject(project, object, {
      type: command.type.replace('.create', '.remove') as
        'camera.remove' | 'htmlScene.remove' | 'motionScene.remove' | 'image.remove',
      payload: { objectId: object.id },
    } as VisualObjectCommand);
  }
  if (command.type === 'camera.remove')
    return removeObject(project, command.payload.objectId, 'camera', (object) => ({
      type: 'camera.create',
      payload: { object },
    }));
  if (command.type === 'htmlScene.remove')
    return removeObject(project, command.payload.objectId, 'html-scene', (object) => ({
      type: 'htmlScene.create',
      payload: { object },
    }));
  if (command.type === 'motionScene.remove')
    return removeObject(project, command.payload.objectId, 'motion-scene', (object) => ({
      type: 'motionScene.create',
      payload: { object },
    }));
  if (command.type === 'image.remove')
    return removeObject(project, command.payload.objectId, 'image', (object) => ({
      type: 'image.create',
      payload: { object },
    }));
  throw new RangeError(`unsupported visual command ${(command as { type: string }).type}`);
}

type HistoryRecord = {
  readonly transaction: VisualObjectTransaction;
  readonly inverses: VisualObjectTransaction;
};

export class VisualObjectProjectHistory {
  #present: JoyProjectV1;
  readonly #undo: HistoryRecord[] = [];
  readonly #redo: HistoryRecord[] = [];
  constructor(initial: JoyProjectV1) {
    this.#present = initial;
  }
  get present(): JoyProjectV1 {
    return this.#present;
  }
  apply(transaction: VisualObjectTransaction): JoyProjectV1 {
    let next = this.#present;
    const inverses: VisualObjectCommand[] = [];
    for (const command of transaction.commands) {
      const result = applyCommand(next, command);
      next = result.project;
      inverses.unshift(result.inverse);
    }
    this.#present = next;
    this.#undo.push({
      transaction,
      inverses: { label: `Undo ${transaction.label}`, commands: inverses },
    });
    this.#redo.length = 0;
    return next;
  }
  replacePresent(next: JoyProjectV1): JoyProjectV1 {
    this.#present = next;
    return next;
  }
  undo(): { readonly project: JoyProjectV1; readonly transaction: VisualObjectTransaction } {
    const record = this.#undo.pop();
    if (record === undefined)
      return { project: this.#present, transaction: { label: 'Undo', commands: [] } };
    this.#present = applyVisualObjectProjectTransaction(this.#present, record.inverses);
    this.#redo.push(record);
    return { project: this.#present, transaction: record.inverses };
  }
  redo(): { readonly project: JoyProjectV1; readonly transaction: VisualObjectTransaction } {
    const record = this.#redo.pop();
    if (record === undefined)
      return { project: this.#present, transaction: { label: 'Redo', commands: [] } };
    this.#present = applyVisualObjectProjectTransaction(this.#present, record.transaction);
    this.#undo.push(record);
    return { project: this.#present, transaction: record.transaction };
  }
}
