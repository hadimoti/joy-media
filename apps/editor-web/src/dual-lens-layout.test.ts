import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

describe('Dual Lens trace layout contract', () => {
  it('contains long trace summaries inside the desktop grid cell', () => {
    const match = appCss.match(/\.dual-lens-trace strong\s*\{([\s\S]*?)\n\}/);
    expect(match?.[1]).toBeDefined();
    expect(match?.[1]).toMatch(/display:\s*block;/);
    expect(match?.[1]).toMatch(/width:\s*100%;/);
    expect(match?.[1]).toMatch(/max-width:\s*100%;/);
    expect(match?.[1]).toMatch(/text-overflow:\s*ellipsis;/);
  });
});
