import { describe, expect, it, vi } from 'vitest';
import { addAssetAsSticker } from './AssetLibraryPanel.js';

describe('asset sticker action', () => {
  it('calls onAddSticker for supported images with the preserved source blob', async () => {
    const blob = new Blob(['png'], { type: 'image/png' });
    const onAddSticker = vi.fn();

    await addAssetAsSticker({
      asset: {
        id: 'asset-image-1',
        kind: 'image',
        displayName: 'Sample transparent PNG',
      },
      onAddSticker,
      loadOriginalBlob: async () => blob,
    });

    expect(onAddSticker).toHaveBeenCalledTimes(1);
    expect(onAddSticker).toHaveBeenCalledWith({
      assetId: 'asset-image-1',
      displayName: 'Sample transparent PNG',
      blob,
    });
  });
});
