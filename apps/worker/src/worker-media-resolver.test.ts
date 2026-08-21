import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StaticWorkerMediaResolver } from './worker-media-resolver.js';

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
});
