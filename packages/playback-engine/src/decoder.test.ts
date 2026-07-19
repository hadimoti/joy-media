import { describe, expect, it } from 'vitest';
import { requestDecodedFrame, selectDecodeSource } from './decoder.js';
describe('decoder boundary', () => {
  it('chooses a proxy only when quality requires it and keeps source time explicit', async () => {
    const source = { assetId: 'a', originalToken: 'original', proxyToken: 'proxy' };
    expect(selectDecodeSource(source, 'full')).toBe('original');
    expect(selectDecodeSource(source, 'proxy')).toBe('proxy');
    await expect(
      requestDecodedFrame(
        {
          decode: async (token, time, requestToken) => ({
            assetId: 'a',
            sourceTimeUs: time,
            token: `${token}:${requestToken}`,
          }),
        },
        source,
        1_000_000,
        4,
        'proxy',
      ),
    ).resolves.toEqual({ assetId: 'a', sourceTimeUs: 1_000_000, token: 'proxy:4' });
  });
});
