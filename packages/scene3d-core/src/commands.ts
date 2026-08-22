import { validateScene3DDocument } from './validation.js';
import type {
  Scene3DDocumentV1,
  Scene3DEnvironment,
  Scene3DMaterial,
  Scene3DObject,
  Scene3DTransform,
} from './scene.js';

export type Scene3DCommand =
  | { readonly type: 'object.add'; readonly payload: { readonly object: Scene3DObject } }
  | { readonly type: 'object.remove'; readonly payload: { readonly objectId: string } }
  | {
      readonly type: 'object.setTransform';
      readonly payload: { readonly objectId: string; readonly transform: Scene3DTransform };
    }
  | {
      readonly type: 'object.setMaterial';
      readonly payload: { readonly objectId: string; readonly materialId?: string };
    }
  | { readonly type: 'material.upsert'; readonly payload: { readonly material: Scene3DMaterial } }
  | { readonly type: 'material.remove'; readonly payload: { readonly materialId: string } }
  | {
      readonly type: 'scene.setEnvironment';
      readonly payload: { readonly environment: Scene3DEnvironment };
    }
  | { readonly type: 'scene.setActiveCamera'; readonly payload: { readonly cameraId?: string } };
export interface Scene3DTransaction {
  readonly label: string;
  readonly commands: readonly Scene3DCommand[];
}
export interface Scene3DTransactionRecord {
  readonly transaction: Scene3DTransaction;
  readonly inverses: Scene3DTransaction;
}

export function applyScene3DTransaction(
  document: Scene3DDocumentV1,
  transaction: Scene3DTransaction,
): { readonly document: Scene3DDocumentV1; readonly record: Scene3DTransactionRecord } {
  let next = document;
  const inverses: Scene3DCommand[] = [];
  for (const command of transaction.commands) {
    const result = applyScene3DCommand(next, command);
    next = result.document;
    inverses.unshift(result.inverse);
  }
  const errors = validateScene3DDocument(next);
  if (errors.length > 0)
    throw new RangeError(`scene transaction is invalid: ${errors[0]!.message}`);
  return {
    document: next,
    record: { transaction, inverses: { label: `Undo ${transaction.label}`, commands: inverses } },
  };
}

export function applyScene3DCommand(
  document: Scene3DDocumentV1,
  command: Scene3DCommand,
): { readonly document: Scene3DDocumentV1; readonly inverse: Scene3DCommand } {
  if (command.type === 'object.add') {
    const object = command.payload.object;
    if (document.objects[object.id] !== undefined)
      throw new RangeError(`object "${object.id}" already exists`);
    if (object.parentId !== undefined && document.objects[object.parentId] === undefined)
      throw new RangeError(`parent "${object.parentId}" does not exist`);
    return {
      document: { ...document, objects: { ...document.objects, [object.id]: object } },
      inverse: { type: 'object.remove', payload: { objectId: object.id } },
    };
  }
  if (command.type === 'object.remove') {
    const object = document.objects[command.payload.objectId];
    if (object === undefined)
      throw new RangeError(`object "${command.payload.objectId}" does not exist`);
    if (document.activeCameraId === object.id)
      throw new RangeError('active camera cannot be removed');
    if (Object.values(document.objects).some((candidate) => candidate.parentId === object.id))
      throw new RangeError('object with children cannot be removed');
    const objects = { ...document.objects };
    delete objects[object.id];
    return {
      document: { ...document, objects },
      inverse: { type: 'object.add', payload: { object } },
    };
  }
  if (command.type === 'object.setTransform') {
    const object = document.objects[command.payload.objectId];
    if (object === undefined)
      throw new RangeError(`object "${command.payload.objectId}" does not exist`);
    return {
      document: {
        ...document,
        objects: {
          ...document.objects,
          [object.id]: { ...object, transform: command.payload.transform },
        },
      },
      inverse: {
        type: 'object.setTransform',
        payload: { objectId: object.id, transform: object.transform },
      },
    };
  }
  if (command.type === 'object.setMaterial') {
    const object = document.objects[command.payload.objectId];
    if (object === undefined)
      throw new RangeError(`object "${command.payload.objectId}" does not exist`);
    const nextObject =
      command.payload.materialId === undefined
        ? (() => {
            const { materialId: _previousMaterialId, ...objectWithoutMaterial } = object;
            return objectWithoutMaterial;
          })()
        : { ...object, materialId: command.payload.materialId };
    return {
      document: { ...document, objects: { ...document.objects, [object.id]: nextObject } },
      inverse: {
        type: 'object.setMaterial',
        payload: {
          objectId: object.id,
          ...(object.materialId === undefined ? {} : { materialId: object.materialId }),
        },
      },
    };
  }
  if (command.type === 'material.upsert') {
    const previous = document.materials[command.payload.material.id];
    return {
      document: {
        ...document,
        materials: {
          ...document.materials,
          [command.payload.material.id]: command.payload.material,
        },
      },
      inverse:
        previous === undefined
          ? { type: 'material.remove', payload: { materialId: command.payload.material.id } }
          : { type: 'material.upsert', payload: { material: previous } },
    };
  }
  if (command.type === 'material.remove') {
    const material = document.materials[command.payload.materialId];
    if (material === undefined)
      throw new RangeError(`material "${command.payload.materialId}" does not exist`);
    if (Object.values(document.objects).some((object) => object.materialId === material.id))
      throw new RangeError('material is still referenced');
    const materials = { ...document.materials };
    delete materials[material.id];
    return {
      document: { ...document, materials },
      inverse: { type: 'material.upsert', payload: { material } },
    };
  }
  if (command.type === 'scene.setEnvironment')
    return {
      document: { ...document, environment: command.payload.environment },
      inverse: { type: 'scene.setEnvironment', payload: { environment: document.environment } },
    };
  const cameraId = command.payload.cameraId;
  if (cameraId !== undefined && document.objects[cameraId]?.kind !== 'camera')
    throw new RangeError('active camera must reference a camera object');
  const nextDocument =
    cameraId === undefined
      ? (() => {
          const { activeCameraId: _previousCameraId, ...documentWithoutCamera } = document;
          return documentWithoutCamera;
        })()
      : { ...document, activeCameraId: cameraId };
  return {
    document: nextDocument,
    inverse: {
      type: 'scene.setActiveCamera',
      payload: {
        ...(document.activeCameraId === undefined ? {} : { cameraId: document.activeCameraId }),
      },
    },
  };
}
