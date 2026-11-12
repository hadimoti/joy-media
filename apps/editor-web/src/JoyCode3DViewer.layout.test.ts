import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const viewerSource = readFileSync(new URL('./JoyCode3DViewer.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

/** The declarations of a top-level rule such as `.joy-code-3d-viewport { ... }`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`\\n${escaped} \\{([^}]*)\\}`));
  if (match?.[1] === undefined) throw new Error(`no top-level rule for ${selector}`);
  return match[1];
}

describe('3D scene card layout (T-P02, OB-02)', () => {
  it('measures the unpadded viewport, not the framed card', () => {
    // The renderer sizes itself from containerRef (clientWidth at init, and the
    // ResizeObserver contentRect). Padding on that element would make the canvas
    // wider than the card's inner box.
    expect(viewerSource).toMatch(
      /<div className="joy-code-3d-frame">\s*<div ref=\{containerRef\} className="joy-code-3d-viewport" \/>\s*<\/div>/,
    );
    expect(viewerSource).toContain('container.clientWidth');
    expect(viewerSource).toContain('resizeObserverRef.current.observe(container)');
  });

  it('keeps padding on the frame and off the measured viewport', () => {
    expect(ruleBody('.joy-code-3d-frame')).toMatch(/padding:\s*12px;/);
    expect(ruleBody('.joy-code-3d-viewport')).not.toMatch(/\bpadding/);
  });

  it('gives the card a 10px radius in the panel border colour, clipping the canvas', () => {
    const viewport = ruleBody('.joy-code-3d-viewport');
    expect(viewport).toMatch(/border-radius:\s*10px;/);
    expect(viewport).toMatch(/border:\s*1px solid var\(--joy-border\);/);
    expect(viewport).toMatch(/overflow:\s*hidden;/);
    expect(css).toMatch(/\.joy-code-3d-viewport canvas \{[^}]*border-radius:\s*inherit;/);
  });
});
