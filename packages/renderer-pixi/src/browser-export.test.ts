import { describe, expect, it } from 'vitest';
import { BROWSER_MP4_MIME_TYPE, packBrowserExport } from './browser-export.js';

describe('browser export contracts', () => {
  it('declares the H.264/AAC MP4 recorder contract', () => {
    expect(BROWSER_MP4_MIME_TYPE).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
  });

  it('retains the explicit raw-RGBA interchange fallback', () => {
    const pixels = new Uint8Array([255, 0, 0, 255]);
    const { result } = packBrowserExport({
      manifest: { width: 1, height: 1, frameRate: 30, durationUs: 33_333 },
      frames: [pixels],
      filename: 'fallback.rgba',
    });
    expect(result).toMatchObject({ encoded: false, filename: 'fallback.rgba', totalBytes: 20 });
  });
});
