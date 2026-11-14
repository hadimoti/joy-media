import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, 'app.css'), 'utf8');

/** The z-index of the one rule that starts with exactly this selector at the beginning of a line. */
function zIndexOf(selector: string): number {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const body = css.slice(start, css.indexOf('}', start));
  const value = /z-index:\s*(\d+)/.exec(body);
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
