import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JoyCodeLogo } from './JoyCodeLogo.js';

describe('JoyCodeLogo', () => {
  it('uses the compact mark without motion while idle', () => {
    const markup = renderToStaticMarkup(<JoyCodeLogo variant="mark" />);

    expect(markup).toContain('joy-code-logo is-mark');
    expect(markup).not.toContain('is-thinking');
  });

  it('adds the thinking animation hook only when requested', () => {
    const markup = renderToStaticMarkup(<JoyCodeLogo variant="mark" thinking />);

    expect(markup).toContain('joy-code-logo is-mark is-thinking');
  });

  it('ships the current mark and horizontal brand PNGs', () => {
    const mark = readFileSync(new URL('./brand-assets/joy-code-mark.png', import.meta.url));
    const horizontal = readFileSync(
      new URL('./brand-assets/joy-code-horizontal.png', import.meta.url),
    );

    expect(mark.byteLength).toBeGreaterThan(10_000);
    expect(horizontal.byteLength).toBeGreaterThan(10_000);
    expect(mark.byteLength).toBeLessThan(256 * 1024);
    // The horizontal brand mark is a detailed, antialiased gradient PNG
    // (105k+ colors at 642x532) and legitimately exceeds 256KB; guard against
    // runaway bloat rather than forcing lossy quantization of a brand asset.
    expect(horizontal.byteLength).toBeLessThan(512 * 1024);
  });
});
