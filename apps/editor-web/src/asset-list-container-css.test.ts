import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

/** The body of the last `@container (max-width: <width>)` block, up to its closing brace at column 0. */
function containerBlock(width: string): string {
  const escaped = width.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const all = [
    ...appCss.matchAll(
      new RegExp(`\\n@container \\(max-width: ${escaped}\\) \\{([\\s\\S]*?)\\n\\}`, 'gu'),
    ),
  ];
  return all.at(-1)?.[1] ?? '';
}

// CSS-text checks: they prove the rules exist and follow the panel width, not how the list looks (the live
// look is confirmed in the browser pane and with the desktop driver).
describe('Media list view in a narrow panel', () => {
  it('drops the Collection column when the media panel is narrower than 38rem', () => {
    const block = containerBlock('38rem');
    expect(block).toContain(
      'grid-template-columns: 1.25rem 2.65rem minmax(0, 1fr) 4.5rem 5.35rem;',
    );
    expect(block).toContain('.asset-list-header-collection');
    expect(block).toContain('.asset-grid--list .asset-card-collection');
    expect(block).toContain('display: none;');
  });

  it('also drops the Size column below 31rem and keeps the name column and the actions', () => {
    const block = containerBlock('31rem');
    expect(block).toContain('grid-template-columns: 1.15rem 2.4rem minmax(0, 1fr) 4.25rem;');
    expect(block).toContain('.asset-list-header-size');
    expect(block).toContain('.asset-grid--list .asset-card-meta');
    expect(block).toContain('opacity: 1;');
    expect(block).toContain('pointer-events: auto;');
  });

  it('gives the name column no fixed minimum, so the row never exceeds the panel', () => {
    for (const width of ['38rem', '31rem']) {
      expect(containerBlock(width)).toContain('minmax(0, 1fr)');
    }
  });

  it('keeps the container query on the panel content, which is the size container', () => {
    expect(appCss).toMatch(
      /\.asset-library-content \{\n {2}box-sizing: border-box;\n {2}container-type: inline-size;/u,
    );
  });
});
