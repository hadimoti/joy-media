import { describe, expect, it } from 'vitest';
import { compileScenePackage, FIRST_PARTY_SCENES } from '@joy-media/html-scene-runtime';

describe('P04.5 first-party scene goldens', () => {
  it('pins deterministic reference frames for every built-in scene', () => {
    const hashes = FIRST_PARTY_SCENES.map((scene) => {
      const compiled = compileScenePackage({
        manifest: scene.manifest,
        source: scene.source,
        variableSchema: scene.variableSchema,
      });
      expect(compiled.diagnostics).toEqual([]);
      return compiled.referenceFrameSha256;
    });
    expect(hashes).toEqual([
      '40436c9b4ebdab3fcc13511c52045a37575606cfa9b686150fd58626d1909c98',
      '019217e95000d611dd6aeed21660e6b2542ac66ea7f707d391087b1870f77c30',
      'aec4bcd004037d4bf7dfed88b1d9183ce1a00b6800c1f698a3313318160e65f0',
      'b85d09d8be8e3811b7e5ce878ce6df7dd10080e60acbd441d545c6da4d13fd73',
    ]);
  });
});
