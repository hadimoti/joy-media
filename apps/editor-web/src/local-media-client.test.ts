import { describe, expect, it, vi } from 'vitest';
import type { BrowserAssetRegistration } from './control-plane-client.js';
import { BrowserControlPlaneClient, type DesktopMediaBridge } from './local-media-client.js';

describe('BrowserControlPlaneClient internal staged exports', () => {
  it('registers the internal flag and cleans up by the staged registration id', async () => {
    const bridge: DesktopMediaBridge = {
      invoke: vi.fn(async () => ({ removed: true })),
    };
    const client = new BrowserControlPlaneClient(bridge);
    const asset = {
      id: 'stage-attempt-4',
      kind: 'video',
      displayName: 'render.mp4.stage',
      sha256: 'c'.repeat(64),
      bytes: 42,
      descriptor: { mimeType: 'video/mp4' },
      locations: [{ kind: 'opfs-cache', ref: 'export-stage-4' }],
      internal: true,
    } as BrowserAssetRegistration;

    await client.registerAsset('project-1', asset);
    expect(bridge.invoke).toHaveBeenNthCalledWith(
      1,
      'desktop.media.asset.register',
      expect.objectContaining({ internal: true }),
    );

    await client.deleteInternalAsset('project-1', asset.id);
    expect(bridge.invoke).toHaveBeenNthCalledWith(2, 'desktop.media.asset.remove-internal', {
      assetId: asset.id,
    });
  });
});
