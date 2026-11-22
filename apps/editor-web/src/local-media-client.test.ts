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

describe('BrowserControlPlaneClient local masks', () => {
  it('sends a mask job through desktop.media.mask.run and reports its result as a mask derivative', async () => {
    const view = {
      id: 'desktop-job-1',
      jobType: 'mask.video',
      status: 'done',
      progress: 100,
      cancelRequested: false,
      derivative: { sha256: 'd'.repeat(64), bytes: 1234, mimeType: 'video/webm' },
    };
    const invoke = vi.fn(async (channel: string) =>
      channel === 'desktop.media.mask.run' ? { jobId: 'desktop-job-1' } : view,
    );
    const client = new BrowserControlPlaneClient({ invoke } as DesktopMediaBridge);

    const queued = await client.enqueueMask('p-mask', 'editor-job-1', 'mask.video', 'asset-1', {
      mode: 'subject',
    });
    expect(invoke).toHaveBeenCalledWith('desktop.media.mask.run', {
      refId: 'asset-1',
      jobType: 'mask.video',
      payload: { mode: 'subject' },
    });
    expect(queued).toMatchObject({ id: 'editor-job-1', type: 'mask.video', state: 'queued' });

    const [job] = await client.jobs('p-mask');
    expect(job).toMatchObject({
      id: 'editor-job-1',
      state: 'completed',
      derivative: { kind: 'mask', bytes: 1234 },
    });
    const [derivative] = await client.derivatives('p-mask', 'asset-1');
    expect(derivative).toMatchObject({
      kind: 'mask',
      profile: 'mask-matte',
      descriptor: { mimeType: 'video/webm' },
    });
  });
});
