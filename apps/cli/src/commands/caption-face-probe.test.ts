import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { captionEngineVersionsFromAssProbe, probeCanonicalCaptionFace } from './render-features.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe('caption engine versions from the FFmpeg log', () => {
  it('reads the libass source and HarfBuzz version that this FFmpeg build prints', () => {
    const log = [
      '[Parsed_ass_0 @ 0000000000824e00] libass API version: 0x1705000',
      '[Parsed_ass_0 @ 0000000000824e00] libass source: meson, commit: 3087d2b2ffda76602a17f9b09d25cb8addc8d313',
      '[Parsed_ass_0 @ 0000000000824e00] Shaper: FriBidi 1.0.16 (SIMPLE) HarfBuzz-ng 14.3.0 (COMPLEX)',
    ].join('\n');
    expect(captionEngineVersionsFromAssProbe(log)).toMatchObject({
      libassVersion: 'meson commit 3087d2b2ffda76602a17f9b09d25cb8addc8d313',
      shaperVersion: '14.3.0',
    });
  });
});

describe.skipIf(!hasFfmpeg)('canonical caption face probe', () => {
  it('finds the bundled canonical face usable when libass loads and draws it', () => {
    const probe = probeCanonicalCaptionFace();
    expect(probe.reason).toBeUndefined();
    expect(probe.usable).toBe(true);
  });

  it('judges a corrupted canonical face unusable, so the caption setup refuses', () => {
    const probe = probeCanonicalCaptionFace(undefined, new TextEncoder().encode('not a font file'));
    expect(probe.usable).toBe(false);
    expect(probe.reason).toBeDefined();
  });
});
