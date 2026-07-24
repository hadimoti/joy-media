import { describe, expect, it } from 'vitest';
import { heuristicTags, normalizeSortName, tagAssetWithHermes } from './asset-hermes-tags.js';

describe('asset-hermes-tags', () => {
  it('tags images with format and hermes provenance tokens', async () => {
    const result = await tagAssetWithHermes({
      kind: 'image',
      displayName: 'نوشته.png',
      mimeType: 'image/png',
      bytes: 353,
    });
    expect(result.provenance).toBe('hermes-heuristic');
    expect(result.tags).toContain('hermes');
    expect(result.tags).toContain('image');
    expect(result.tags).toContain('png');
    expect(result.tags).toContain('fa');
    expect(result.sortName).toBe(normalizeSortName('نوشته.png'));
  });

  it('marks gif/webp as animated candidates', () => {
    const tags = heuristicTags({
      kind: 'image',
      displayName: 'multimedia-gif.webp',
      mimeType: 'image/webp',
      bytes: 360_000,
    });
    expect(tags).toContain('webp');
    expect(tags).toContain('animated-candidate');
    expect(tags).toContain('name-multimedia');
  });
});
