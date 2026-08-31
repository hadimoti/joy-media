import { describe, expect, it } from 'vitest';
import { createThreeDSourceRef, sourceRefDisplayName } from './three-d-source-cache.js';

describe('3D source references', () => {
  it('uses an opaque scene-scoped reference while retaining a safe reload filename', () => {
    const ref = createThreeDSourceRef('scene-123', 2, 'models/product model.glb');
    expect(ref).toBe('scene-123/2-product%20model.glb');
    expect(sourceRefDisplayName(ref)).toBe('product model.glb');
  });

  it('rejects unsafe scene IDs', () => {
    expect(() => createThreeDSourceRef('../escape', 0, 'model.glb')).toThrow(
      'invalid 3D source reference',
    );
  });
});
