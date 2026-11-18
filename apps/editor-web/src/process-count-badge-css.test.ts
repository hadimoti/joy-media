import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

// CSS-text check: the header sits at the top edge of the window, so a count badge that sticks out above its
// button was cut off by the window frame (owner screenshot, 18 Nov).
describe('Recent processes count badge', () => {
  const rule = appCss.match(/\.process-center-count \{([\s\S]*?)\n\}/u)?.[1] ?? '';

  it('sits inside its button, never above or beside it', () => {
    expect(rule).toContain('position: absolute;');
    expect(rule).not.toMatch(/(?:top|right|left|bottom):\s*-/u);
    expect(rule).toMatch(/bottom:\s*0\.05rem;/u);
    expect(rule).toMatch(/right:\s*0\.05rem;/u);
  });

  it('is placed against a positioned button', () => {
    const trigger = appCss.match(/\.header-processes-trigger \{([\s\S]*?)\n\}/u)?.[1] ?? '';
    expect(trigger).toContain('position: relative;');
  });
});
