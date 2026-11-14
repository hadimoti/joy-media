import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, 'app.css'), 'utf8');

function zIndexOf(selector: string): number {
  const block = new RegExp(`(?:^|\n)${selector.replace(/[.]/g, '\.')} \{([^}]*)\}`).exec(css);
  const value = block === null ? null : /z-index:\s*(\d+)/.exec(block[1] ?? '');
  if (value === null) throw new Error(`no z-index for ${selector}`);
  return Number(value[1]);
}

describe('the playhead stacks above the track titles and the timecode block', () => {
  it('lifts the playhead rail above the sticky track titles', () => {
    expect(zIndexOf('.timeline-playhead')).toBeGreaterThan(9);
  });

  it('lifts the scrub handle above the timecode block (4)', () => {
    expect(zIndexOf('.timeline-playhead--scrub')).toBeGreaterThan(4);
  });
});
