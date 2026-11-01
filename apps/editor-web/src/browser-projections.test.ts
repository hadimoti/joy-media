import { describe, expect, it } from 'vitest';
import { browserAsset } from './browser-projections.js';

describe('browser asset projection', () => {
  it('projects assets as local without requiring cloud catalog metadata', () => {
    const asset = browserAsset({
      id: 'asset-1',
      projectId: 'project-1',
      kind: 'image',
      displayName: 'Badge',
      sha256: 'a'.repeat(64),
      bytes: 12,
      descriptor: { mimeType: 'image/png' },
      createdAt: 1,
    });

    expect(asset.cloudBacked).toBe(false);
  });
});
