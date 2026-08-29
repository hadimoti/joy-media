import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

function compactHeaderCss(): string {
  const start = appCss.indexOf('@media (max-width: 45rem)');
  const end = appCss.indexOf('@media (max-width: 22rem)', start);
  if (start < 0 || end < 0) throw new Error('compact header media queries are missing');
  return appCss.slice(start, end);
}

describe('compact application header layout contract', () => {
  it('keeps the Brand menu in a bounded row above editing controls', () => {
    const css = compactHeaderCss();

    expect(css).toMatch(
      /\.app-header\s*\{[\s\S]*height:\s*auto;[\s\S]*flex-wrap:\s*wrap;[\s\S]*overflow:\s*hidden;/,
    );
    expect(css).toMatch(
      /\.app-header > \.header-group\[aria-label='Brand'\]\s*\{[\s\S]*flex:\s*1 1 100%;[\s\S]*min-width:\s*100%;[\s\S]*overflow:\s*hidden;/,
    );
    expect(css).toMatch(
      /\.app-menubar\s*\{[\s\S]*flex:\s*1 1 0;[\s\S]*min-width:\s*0;[\s\S]*width:\s*0;[\s\S]*overflow-x:\s*auto;[\s\S]*overflow-y:\s*hidden;/,
    );
  });

  it('keeps Edit and Deliver hit targets in bounded, separately scrollable rows', () => {
    const css = compactHeaderCss();

    expect(css).toMatch(
      /\.app-header > \.header-group\[aria-label='Edit'\]\s*\{[\s\S]*min-width:\s*0;[\s\S]*overflow-x:\s*auto;[\s\S]*overflow-y:\s*hidden;/,
    );
    expect(appCss).toMatch(
      /@media \(max-width: 22rem\)[\s\S]*\.app-header > \.header-group\[aria-label='Deliver'\]\s*\{[\s\S]*flex-basis:\s*100%;/,
    );
  });

  it('preserves the DOM focus order Brand → Edit → Deliver', () => {
    const brand = appSource.indexOf('aria-label="Brand"');
    const edit = appSource.indexOf('aria-label="Edit"');
    const deliver = appSource.indexOf('aria-label="Deliver"');

    expect(brand).toBeGreaterThanOrEqual(0);
    expect(edit).toBeGreaterThan(brand);
    expect(deliver).toBeGreaterThan(edit);
  });
});
