import { describe, expect, it, vi } from 'vitest';
import {
  createThreeDResourceResolver,
  normalizeResourcePath,
} from './three-d-resource-resolver.js';

describe('three-dimensional model resource resolver', () => {
  it('maps encoded relative GLTF resources to selected files and reuses URLs', () => {
    const model = new File(['{}'], 'scene.gltf', { type: 'model/gltf+json' });
    const texture = new File(['png'], 'textures/Holo Badge.png', { type: 'image/png' });
    const createObjectUrl = vi.fn((file: Blob) => `blob:${(file as File).name}`);
    const revokeObjectUrl = vi.fn();
    const resolver = createThreeDResourceResolver(
      [model, texture],
      createObjectUrl,
      revokeObjectUrl,
    );

    expect(resolver.resolve('textures/Holo%20Badge.png')).toBe('blob:textures/Holo Badge.png');
    expect(resolver.resolve('./textures/Holo%20Badge.png')).toBe('blob:textures/Holo Badge.png');
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    resolver.revokeAll();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:textures/Holo Badge.png');
  });

  it('fails closed when a GLTF references an unselected external resource', () => {
    const resolver = createThreeDResourceResolver(
      [new File(['{}'], 'scene.gltf', { type: 'model/gltf+json' })],
      vi.fn(() => 'blob:unused'),
      vi.fn(),
    );

    expect(() => resolver.resolve('https://example.invalid/secret.bin')).toThrow(
      /missing resource/,
    );
  });

  it('normalizes URL encoding, query strings, and slash variants', () => {
    expect(normalizeResourcePath('./textures\\Badge%20A.png?v=1')).toBe('textures/Badge A.png');
    expect(normalizeResourcePath('https://cdn.example.test/a.bin#fragment')).toBe('a.bin');
  });
});
