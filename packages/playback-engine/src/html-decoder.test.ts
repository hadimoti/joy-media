import { describe, expect, it } from 'vitest';
import { createHtmlMediaDecoder } from './html-decoder.js';

describe('HTML media decoder tier', () => {
  it('seeks in source time and labels the request generation', async () => {
    const listeners = new Map<string, () => void>();
    const video = {
      src: '',
      currentTime: 0,
      readyState: 4,
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    await expect(createHtmlMediaDecoder(video).decode('proxy-url', 1_250_000, 7)).resolves.toEqual({
      assetId: 'proxy-url',
      sourceTimeUs: 1_250_000,
      token: 'html-media:7',
    });
    expect(video.currentTime).toBe(1.25);
  });
});
