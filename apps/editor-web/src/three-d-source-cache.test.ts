import { describe, expect, it } from 'vitest';
import { createThreeDSourceRef, sourceRefDisplayName } from './three-d-source-cache.js';

describe('3D source references', () => {
  it('bounds long Unicode names without creating an undecodable reference', () => {
    const ref = createThreeDSourceRef('scene-1', 0, `${'模型'.repeat(200)}.bin`);
    expect(ref.length).toBeLessThanOrEqual('scene-1/'.length + 4 + 180);
    expect(() => sourceRefDisplayName(ref)).not.toThrow();
    expect(sourceRefDisplayName(ref)).not.toBe('source.bin');
  });

  it('strips path components before persisting a dependency name', () => {
    const ref = createThreeDSourceRef('scene-1', 2, 'textures\\../albedo.png');
    expect(sourceRefDisplayName(ref)).toBe('albedo.png');
  });
});
