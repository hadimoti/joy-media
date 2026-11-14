import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

/** Declarations of the rule whose selector is exactly `selector`. */
function declarationsOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = appCss.match(new RegExp(`(?:^|\\n)${escaped} \\{([\\s\\S]*?)\\n\\}`));
  return match?.[1]?.trim() ?? '';
}

describe('Missing clip on the timeline (T-R03)', () => {
  it('greys and hatches the clip without a filter, so the badge and selection keep their colours', () => {
    const rule = declarationsOf('.timeline-clip.is-missing');
    expect(rule).toMatch(/repeating-linear-gradient/);
    expect(rule).not.toMatch(/filter/);
  });

  it('keeps the accent outline when the missing clip is selected', () => {
    expect(declarationsOf(".timeline-clip.is-missing[aria-pressed='true']")).toContain(
      'outline: 2px solid var(--joy-accent);',
    );
  });

  it('keeps the accent focus ring when the missing clip has keyboard focus', () => {
    expect(declarationsOf('.timeline-clip.is-missing:focus-visible')).toContain(
      'outline: 2px solid var(--joy-accent);',
    );
  });
});

describe('Monitor "Media offline" note (T-R03)', () => {
  it('is a corner card that lets pointer events through and never covers the stage', () => {
    const rule = declarationsOf('.monitor-media-offline');
    expect(rule).toContain('pointer-events: none;');
    expect(rule).not.toMatch(/inset:\s*0/);
    expect(rule).not.toMatch(/background:\s*#15161a/);
  });
});
