import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  StaticWorkerMediaResolver,
  mediaResolverFromAssetSourceRegistry,
} from './worker-media-resolver.js';

describe('Worker media resolver', () => {
  it('resolves opaque refs to Worker-private paths without exposing those paths', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-worker-resolver-'));
    const localPath = join(directory, 'clip.mp4');
    writeFileSync(localPath, 'private media');
    const resolver = new StaticWorkerMediaResolver({ 'asset:clip-a': localPath });

    expect(resolver.require('asset:clip-a')).toEqual({ kind: 'file', path: localPath });
    expect(resolver.describe('asset:clip-a')).toEqual({ opaqueRef: 'asset:clip-a' });
    expect(JSON.stringify(resolver.describe('asset:clip-a'))).not.toContain(localPath);
  });

  it('refuses missing required opaque refs', () => {
    const resolver = new StaticWorkerMediaResolver({});

    expect(() => resolver.require('asset:missing')).toThrow(/asset:missing/);
  });

  it('resolves published Motion Studio media through the private source registry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-worker-motion-resolver-'));
    const localPath = join(directory, 'motion-doc-1.mp4');
    writeFileSync(localPath, 'published motion media');
    const resolver = mediaResolverFromAssetSourceRegistry({
      resolve: (assetId) => (assetId === 'motion-scene:motion-doc-1' ? localPath : undefined),
    });

    expect(resolver.require('motion-scene:motion-doc-1')).toEqual({
      kind: 'file',
      path: localPath,
    });
  });

  it('fails closed with evidence when Motion Studio media is not published', () => {
    const resolver = mediaResolverFromAssetSourceRegistry({ resolve: () => undefined });

    expect(() => resolver.require('motion-scene:missing-scene')).toThrow(
      /motion scene media is unavailable.*publish or render/i,
    );
  });
});
