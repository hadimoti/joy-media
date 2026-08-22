import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  disposeThreeObject,
  JoyCode3DViewer,
  isSupported3DAsset,
  hasExternalGltfDependencies,
  isStale3DLoad,
  registered3DAssets,
  revoke3DObjectUrl,
  resolveRegistered3DAsset,
} from './JoyCode3DViewer.js';
import type { BrowserAsset } from './control-plane-client.js';

const MODEL: BrowserAsset = {
  id: 'model-1',
  projectId: 'project-1',
  kind: 'model',
  displayName: 'hero.glb',
  sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
  bytes: 4,
  descriptor: { mimeType: 'model/gltf-binary' },
  createdAt: 1,
};

describe('JoyCode3DViewer asset boundary', () => {
  it('only selects registered GLB/GLTF catalog assets', () => {
    expect(isSupported3DAsset(MODEL)).toBe(true);
    expect(isSupported3DAsset({ ...MODEL, kind: 'image' })).toBe(false);
    expect(
      isSupported3DAsset({ ...MODEL, descriptor: { mimeType: 'application/octet-stream' } }),
    ).toBe(false);
    expect(registered3DAssets([MODEL, { ...MODEL, id: 'image-1', kind: 'image' }])).toEqual([
      MODEL,
    ]);
  });

  it('checks the catalog byte contract before loading', async () => {
    await expect(
      resolveRegistered3DAsset(
        MODEL,
        async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'model/gltf-binary' }),
      ),
    ).resolves.toBeInstanceOf(Blob);
    await expect(
      resolveRegistered3DAsset(
        MODEL,
        async () => new Blob([new Uint8Array([1])], { type: 'model/gltf-binary' }),
      ),
    ).rejects.toThrow('integrity');
  });

  it('renders an honest empty state instead of a fake file picker', () => {
    const markup = renderToStaticMarkup(<JoyCode3DViewer assets={[]} />);
    expect(markup).toContain('No registered 3D assets');
    expect(markup).toContain('Import a GLB or GLTF through Assets first');
    expect(markup).not.toContain('type="file"');
  });

  it('releases geometry and material resources when a model is replaced', () => {
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    const geometryDispose = geometry.dispose;
    const materialDispose = material.dispose;
    let geometryReleased = false;
    let materialReleased = false;
    geometry.dispose = () => {
      geometryReleased = true;
      geometryDispose.call(geometry);
    };
    material.dispose = () => {
      materialReleased = true;
      materialDispose.call(material);
    };
    disposeThreeObject(mesh);
    expect(geometryReleased).toBe(true);
    expect(materialReleased).toBe(true);
  });

  it('guards stale completions and revokes object URLs through one seam', () => {
    expect(isStale3DLoad(1, 2)).toBe(true);
    expect(isStale3DLoad(2, 2)).toBe(false);
    const revoked: string[] = [];
    revoke3DObjectUrl('blob:test', (url) => revoked.push(url));
    expect(revoked).toEqual(['blob:test']);
  });

  it('detects unbundled GLTF dependencies and keeps the limitation explicit', async () => {
    const external = new Blob([JSON.stringify({ buffers: [{ uri: 'mesh.bin' }] })], {
      type: 'model/gltf+json',
    });
    const embedded = new Blob(
      [JSON.stringify({ buffers: [{ uri: 'data:application/octet-stream;base64,AA==' }] })],
      { type: 'model/gltf+json' },
    );
    await expect(hasExternalGltfDependencies(external)).resolves.toBe(true);
    await expect(hasExternalGltfDependencies(embedded)).resolves.toBe(false);
  });
});
