import { describe, expect, it } from 'vitest';
import { createManifestResolver, findUnresolved, SceneAssetError } from './resolver.js';

describe('createManifestResolver', () => {
  const { assets, fonts } = createManifestResolver(
    { logo: 'data:image/png;base64,AAAA' },
    { Vazir: 'data:font/woff2;base64,BBBB' },
  );

  it('resolves declared assets and fonts to self-contained handles', () => {
    expect(assets.resolve('logo')).toBe('data:image/png;base64,AAAA');
    expect(fonts.resolve('Vazir')).toBe('data:font/woff2;base64,BBBB');
    expect(assets.has('logo')).toBe(true);
    expect(fonts.has('Missing')).toBe(false);
  });

  it('throws a coded error on an unresolved asset instead of returning empty', () => {
    expect(() => assets.resolve('missing')).toThrow(SceneAssetError);
    try {
      assets.resolve('missing');
    } catch (error) {
      expect((error as SceneAssetError).code).toBe('SCENE_ASSET_UNRESOLVED');
    }
    expect(() => fonts.resolve('Missing')).toThrow(/SCENE_FONT_UNRESOLVED|unresolved font/);
  });

  it('finds the ids a resolver cannot satisfy for an export preflight', () => {
    expect(findUnresolved(assets, ['logo', 'hero', 'bg'])).toEqual(['hero', 'bg']);
    expect(findUnresolved(assets, ['logo'])).toEqual([]);
  });
});
