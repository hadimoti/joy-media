import { migrateScene3DDocument, type Scene3DDocumentV1 } from '@joy-media/scene3d-core';

const PREFIX = 'joy-media.scene3d.v1:';

export function loadScene3DDocument(
  storage: Pick<Storage, 'getItem'>,
  sceneId: string,
): Scene3DDocumentV1 | undefined {
  try {
    const raw = storage.getItem(`${PREFIX}${sceneId}`);
    return raw === null ? undefined : migrateScene3DDocument(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

export function saveScene3DDocument(
  storage: Pick<Storage, 'setItem'>,
  document: Scene3DDocumentV1,
): void {
  storage.setItem(`${PREFIX}${document.id}`, JSON.stringify(document));
}

export function deleteScene3DDocument(storage: Pick<Storage, 'removeItem'>, sceneId: string): void {
  storage.removeItem(`${PREFIX}${sceneId}`);
}
