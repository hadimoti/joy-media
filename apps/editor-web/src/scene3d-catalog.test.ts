import { describe, expect, it } from 'vitest';
import { emptyScene3D } from '@joy-media/scene3d-core';
import { loadScene3DDocument, saveScene3DDocument } from './scene3d-catalog.js';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;
}

describe('scene3d catalog', () => {
  it('saves and reopens a separate durable scene domain', () => {
    const storage = memoryStorage();
    const scene = emptyScene3D('scene-1', 'Studio');
    saveScene3DDocument(storage, scene);
    expect(loadScene3DDocument(storage, 'scene-1')).toEqual(scene);
    expect(loadScene3DDocument(storage, 'missing')).toBeUndefined();
  });

  it('fails closed on malformed persisted JSON', () => {
    const storage = memoryStorage();
    storage.setItem('joy-media.scene3d.v1:scene-1', '{"schemaVersion":1}');
    expect(loadScene3DDocument(storage, 'scene-1')).toBeUndefined();
  });
});
