import { describe, expect, it } from 'vitest';
import { LocalAssetBridge } from './assets.js';

const ORIGINAL_PATH = 'C:\\Users\\Creator\\Videos\\private-8gb-source.mov';
const EIGHT_GIB = 8 * 1024 * 1024 * 1024;
const HASH = `sha256:${'a'.repeat(64)}`;

describe('local asset bridge spike', () => {
  it('registers a multi-gigabyte selected asset with an opaque location only', () => {
    const bridge = new LocalAssetBridge('worker-local-1', () => ({ byteLength: 1 }));
    const record = bridge.registerSelectedFile({
      absolutePath: ORIGINAL_PATH,
      displayName: 'private-8gb-source.mov',
      kind: 'video',
      contentHash: HASH,
      byteLength: EIGHT_GIB,
    });
    expect(record).toMatchObject({ id: 'asset-1', byteLength: EIGHT_GIB, contentHash: HASH });
    expect(record.locations[0]).toMatchObject({ kind: 'worker-file', workerId: 'worker-local-1' });
    expect(record.locations[0]!.opaquePathId).not.toContain('Videos');
    expect(record.locations[0]!.opaquePathId).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record)).not.toContain(ORIGINAL_PATH);
  });

  it('uses the original only inside the bridge to make a local thumbnail', () => {
    const calls: string[] = [];
    const bridge = new LocalAssetBridge('worker-local-1', (request) => {
      calls.push(`${request.sourcePath}|${request.kind}|${request.maxEdgePx}`);
      return { byteLength: 43_210 };
    });
    const asset = bridge.registerSelectedFile({
      absolutePath: ORIGINAL_PATH,
      displayName: 'private-8gb-source.mov',
      kind: 'video',
      contentHash: HASH,
      byteLength: EIGHT_GIB,
    });
    const derivative = bridge.generateDerivative(asset.id, 'thumbnail', 720);
    expect(calls).toEqual([`${ORIGINAL_PATH}|thumbnail|720`]);
    expect(derivative).toMatchObject({
      id: 'derivative-1',
      sourceAssetId: asset.id,
      byteLength: 43_210,
    });
    expect(JSON.stringify(derivative)).not.toContain(ORIGINAL_PATH);
  });

  it('keeps the original out of the control-plane record after a proxy is created', () => {
    const bridge = new LocalAssetBridge('worker-local-1', () => ({ byteLength: 987_654 }));
    const asset = bridge.registerSelectedFile({
      absolutePath: ORIGINAL_PATH,
      displayName: 'private-8gb-source.mov',
      kind: 'video',
      contentHash: HASH,
      byteLength: EIGHT_GIB,
    });
    bridge.generateDerivative(asset.id, 'proxy', 540);
    const message = bridge.controlPlaneRecord(asset.id);
    expect(message.derivatives).toHaveLength(1);
    expect(message.derivatives[0]!.kind).toBe('proxy');
    expect(message.displayName).toBe('private-8gb-source.mov');
    expect(JSON.stringify(message)).not.toContain(ORIGINAL_PATH);
  });
});
