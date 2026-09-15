import { describe, expect, it, vi } from 'vitest';
import { createReleasePublisher } from './release-publish.js';
import type { ReleaseManifestPayload, ReleaseSigner } from './release-signing.js';
import type { ReleaseMetadataApi } from './release-metadata-service.js';

const payload: ReleaseManifestPayload = {
  channel: 'beta',
  version: '2.0.0-beta.1',
  downloadUrl: 'https://joyst.ir/downloads/joy-media-beta.exe',
  sha256: 'b'.repeat(64),
};

describe('createReleasePublisher', () => {
  it('signs the exact payload and persists the signed release metadata', async () => {
    const signed = { payload, signature: 'signed-value' };
    const signer: ReleaseSigner = { publicKeyPem: 'public-key', sign: vi.fn(() => signed) };
    const published = {
      id: 'release-1',
      ...payload,
      signature: signed.signature,
      publishedAt: 123,
    };
    const metadata: ReleaseMetadataApi = {
      latest: vi.fn(),
      publish: vi.fn(async (input) => ({ ...input, publishedAt: 123 })),
    };

    await expect(
      createReleasePublisher({ metadata, signer }).publish({ id: 'release-1', payload }),
    ).resolves.toEqual(published);
    expect(signer.sign).toHaveBeenCalledWith(payload);
    expect(metadata.publish).toHaveBeenCalledWith({
      id: 'release-1',
      ...payload,
      signature: signed.signature,
    });
  });

  it('propagates a disabled signer failure without calling metadata', async () => {
    const metadata: ReleaseMetadataApi = {
      latest: vi.fn(),
      publish: vi.fn(),
    };
    const signer: ReleaseSigner = {
      publicKeyPem: '',
      sign: vi.fn(() => {
        throw new Error('SIGNING_UNCONFIGURED');
      }),
    };
    await expect(
      createReleasePublisher({ metadata, signer }).publish({ id: 'release-1', payload }),
    ).rejects.toThrow('SIGNING_UNCONFIGURED');
    expect(metadata.publish).not.toHaveBeenCalled();
  });
});
