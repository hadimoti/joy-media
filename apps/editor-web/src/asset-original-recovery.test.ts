import { describe, expect, it, vi } from 'vitest';
import type { BrowserAsset } from './control-plane-client.js';
import { verifyOriginalRecoveryCandidate } from './asset-original-recovery.js';

const exact = new File(['legacy original'], 'legacy.mp4', { type: 'video/mp4' });

describe('verifyOriginalRecoveryCandidate', () => {
  it('accepts exact video bytes before the existing upload client is invoked', async () => {
    const upload = vi.fn();
    await verifyOriginalRecoveryCandidate(assetFor(exact), exact);
    upload(exact);
    expect(upload).toHaveBeenCalledOnce();
  });

  it('rejects a byte-length or SHA mismatch before upload', async () => {
    const upload = vi.fn();
    await expect(
      verifyOriginalRecoveryCandidate(
        assetFor(exact),
        new File(['different'], 'other.mp4', { type: 'video/mp4' }),
      ),
    ).rejects.toThrow('byte length');
    const sameSizeWrongHash = new File(['legacy originaL'], 'other.mp4', { type: 'video/mp4' });
    await expect(
      verifyOriginalRecoveryCandidate(assetFor(exact), sameSizeWrongHash),
    ).rejects.toThrow('SHA-256');
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects a non-video candidate and a non-video registered asset', async () => {
    await expect(
      verifyOriginalRecoveryCandidate(
        assetFor(exact),
        new File(['legacy original'], 'still.png', { type: 'image/png' }),
      ),
    ).rejects.toThrow('not a video');
    await expect(
      verifyOriginalRecoveryCandidate({ ...assetFor(exact), kind: 'image' }, exact),
    ).rejects.toThrow('registered video');
  });
});

function assetFor(file: File): Pick<BrowserAsset, 'kind' | 'sha256' | 'bytes'> {
  return {
    kind: 'video',
    sha256: '659b809b8b3b9ac76e70e2f63eb9be2b177842fc15c25ad68a4a4b5e26df2971',
    bytes: file.size,
  };
}
