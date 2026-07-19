import { describe, expect, it } from 'vitest';
import { compileScenePackage } from './compile.js';
import {
  findFirstPartyScene,
  FIRST_PARTY_SCENES,
  resolveFirstPartySceneInstance,
} from './first-party.js';

describe('first-party JOY scene packages', () => {
  it('ships title, product card, lower third, and data-list templates', () => {
    expect(FIRST_PARTY_SCENES.map((scene) => scene.id)).toEqual([
      'joy.firstparty.title',
      'joy.firstparty.product-card',
      'joy.firstparty.lower-third',
      'joy.firstparty.data-list',
    ]);
    for (const scene of FIRST_PARTY_SCENES) {
      const compiled = compileScenePackage({
        manifest: scene.manifest,
        source: scene.source,
        variableSchema: scene.variableSchema,
      });
      expect(compiled.diagnostics).toEqual([]);
      expect(compiled.referenceFrameSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('resolves nested-composition variables with local overrides taking precedence', () => {
    const resolved = resolveFirstPartySceneInstance(
      'joy.firstparty.title',
      { title: 'Nested local', accent: '#0f0' },
      { title: 'Template title', subtitle: 'Parent subtitle', accent: '#fff' },
    );
    expect(resolved?.variables).toEqual({
      title: 'Nested local',
      subtitle: 'Parent subtitle',
      accent: '#0f0',
    });
    expect(findFirstPartyScene('missing')).toBeUndefined();
  });
});
