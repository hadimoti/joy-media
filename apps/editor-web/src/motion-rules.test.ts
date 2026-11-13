import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T-D16 — the motion rules and the type and space steps the redesign uses.
 * Reads app.css: the tokens exist with their values, the hover-class
 * transitions use the hover token, and the playhead and drags never animate.
 */

const css = readFileSync(fileURLToPath(new URL('./app.css', import.meta.url)), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

function tokenValue(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
  expect(match, name).not.toBeNull();
  return match![1]!.trim();
}

describe('T-D16 tokens', () => {
  it('defines the type steps 15, 18 and 24 px', () => {
    expect(tokenValue('--joy-type-lg')).toBe('0.9375rem');
    expect(tokenValue('--joy-type-xl')).toBe('1.125rem');
    expect(tokenValue('--joy-type-2xl')).toBe('1.5rem');
  });

  it('defines space step 6 as 32 px', () => {
    expect(tokenValue('--space-6')).toBe('32px');
  });

  it('defines hover 120 ms, menus 160 ms, dialogs 200 ms and one easing', () => {
    expect(tokenValue('--joy-motion-hover')).toBe('120ms');
    expect(tokenValue('--joy-motion-menu')).toBe('160ms');
    expect(tokenValue('--joy-motion-dialog')).toBe('200ms');
    expect(tokenValue('--joy-ease')).toBe('cubic-bezier(0.2, 0, 0, 1)');
  });
});

describe('T-D16 motion rules', () => {
  it('no hover-class transition keeps a literal 0.12 to 0.15 s duration', () => {
    const transitions = css.match(/transition(?:-duration)?:[^;{}]*;/g) ?? [];
    const literal = transitions.filter((declaration) =>
      /\b0\.1[245]s\b|\b120ms\b/.test(declaration),
    );
    expect(literal).toEqual([]);
  });

  it('the playhead and dragged elements never animate', () => {
    expect(css).toMatch(/\.timeline-playhead[^{]*\{[^}]*transition:\s*none !important/);
    expect(css).toMatch(/\.is-dragging[^{]*\{[^}]*transition:\s*none !important/);
  });

  it('reduced motion turns animations and transitions off', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*,[\s\S]*?transition-duration:\s*0\.01ms !important/,
    );
  });

  it('timecode and Inspector numbers use tabular figures', () => {
    expect(css).toMatch(/\.timeline-timecode[^{]*\{[^}]*font-variant-numeric:\s*tabular-nums/);
    expect(css).toMatch(/\.inspector-prop input\[type='number'\][^{]*\{[^}]*tabular-nums/);
  });
});
