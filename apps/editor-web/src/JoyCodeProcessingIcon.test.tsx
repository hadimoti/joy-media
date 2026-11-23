import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JoyCodeProcessingIcon } from './JoyCodeProcessingIcon.js';

describe('JoyCodeProcessingIcon', () => {
  it('renders no image while idle', () => {
    expect(renderToStaticMarkup(<JoyCodeProcessingIcon processing={false} />)).toBe('');
  });

  it('uses the processing image as a decorative animation while busy', () => {
    const markup = renderToStaticMarkup(<JoyCodeProcessingIcon processing />);

    expect(markup).toContain('class="joy-code-processing-icon"');
    expect(markup).toContain('joy-code-processing.png');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('alt=""');
  });

  it('ships a small PNG sized for the processing indicator', () => {
    const icon = readFileSync(new URL('./brand-assets/joy-code-processing.png', import.meta.url));
    expect(icon.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect([icon.readUInt32BE(16), icon.readUInt32BE(20)]).toEqual([128, 128]);
    expect(icon.byteLength).toBeLessThan(64 * 1024);
  });
});
