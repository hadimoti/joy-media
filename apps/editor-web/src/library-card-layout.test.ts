import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(dir, 'library-panels.css'), 'utf8');
const card = readFileSync(join(dir, 'LibraryCard.tsx'), 'utf8');

describe('library card layout', () => {
  it('puts the star and the plus inside the picture, with no row under the title', () => {
    // The actions are children of the media wrapper, positioned over the picture's lower edge.
    const media = card.indexOf('library-card-media');
    const actions = card.indexOf('library-card-actions');
    const content = card.indexOf('library-card-content');
    expect(media).toBeGreaterThan(-1);
    expect(actions).toBeGreaterThan(media);
    expect(actions).toBeLessThan(content);
    expect(css).toMatch(/\.library-card-media \{[^}]*position: relative;/);
    expect(css).toMatch(/\.library-card-actions \{[^}]*position: absolute;[^}]*bottom: /);
    expect(css).toMatch(/\.library-card-actions \{[^}]*justify-content: space-between;/);
  });

  it('keeps the description for screen readers only', () => {
    expect(card).toContain('library-card-description sr-only');
  });

  it('draws the plus in the theme colour, also when unavailable', () => {
    expect(css).toMatch(/\.library-card-add \{[^}]*color: var\(--joy-accent\);/);
    expect(css).toMatch(/\.library-card-add:disabled \{[^}]*color: var\(--joy-accent\);/);
    expect(css).toMatch(/\.library-card-favorite \{[^}]*color: var\(--joy-accent\);/);
  });

  it('shows no clip name inside timeline clips', () => {
    const appCss = readFileSync(join(dir, 'app.css'), 'utf8');
    expect(appCss).toMatch(/\.timeline-clip-label \{\s*display: none;/);
  });

  it('keeps the plus a small fixed square', () => {
    expect(css).toMatch(/\.library-card-add \{[^}]*width: 1\.5rem;[^}]*height: 1\.5rem;/);
  });
});
