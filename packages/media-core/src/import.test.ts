import { describe, expect, it } from 'vitest';
import { LocalAssetBridge } from './assets.js';
import { importLocalAsset } from './import.js';
describe('local import registration', () => {
  it('creates derivatives while returning an opaque asset record', () => {
    const record = importLocalAsset(new LocalAssetBridge('worker-1', () => ({ byteLength: 1 })), {
      absolutePath: 'C:\\private\\clip.mov',
      displayName: 'clip.mov',
      kind: 'video',
      contentHash: `sha256:${'b'.repeat(64)}`,
      byteLength: 10,
    });
    expect(record.derivatives.map((derivative) => derivative.kind)).toEqual(['thumbnail', 'proxy']);
    expect(JSON.stringify(record)).not.toContain('private');
  });
});
