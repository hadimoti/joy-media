import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileRegistry } from './file-registry.js';

describe('createFileRegistry', () => {
  const mediaPath = path.join(tmpdir(), 'joy-media-registry-test', 'Media', 'clip.mp4');

  it('resolves a registered ref back to the real path on the main-process side only', () => {
    const registry = createFileRegistry(() => 'ref-1');
    const ref = registry.registerSelection(mediaPath);
    expect(registry.resolvePath(ref)).toBe(mediaPath);
  });

  it('forgets the path once the ref is revoked', () => {
    const registry = createFileRegistry(() => 'ref-1');
    const ref = registry.registerSelection(mediaPath);
    registry.revoke(ref);
    expect(() => registry.resolvePath(ref)).toThrow('Unknown or revoked local file reference');
  });

  it('never resolves a ref it did not itself mint', () => {
    const registry = createFileRegistry();
    expect(() =>
      registry.resolvePath({ kind: 'local-file', id: 'forged', displayName: 'x' }),
    ).toThrow();
  });

  it('still enforces the shared derivative policy (unknown/revoked ref rejected)', () => {
    const registry = createFileRegistry(() => 'ref-1');
    const ref = registry.registerSelection(mediaPath);
    registry.revoke(ref);
    expect(() => registry.requestDerivative(ref, 'thumbnail')).toThrow();
  });
});
