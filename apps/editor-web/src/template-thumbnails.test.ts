import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isOutlineTextTemplate } from './TextPanel.js';
import { TEXT_TEMPLATES, textTemplateById } from './text-template-catalog.js';

/**
 * T-D15: template thumbnails at tile size with a safe margin, and a mid-grey
 * tile behind outline text styles.
 */

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const templatesPanel = readFileSync(new URL('./TemplatesPanel.tsx', import.meta.url), 'utf8');

/** The declarations of one rule of app.css, by its selector text. */
function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('outline text templates (T-D15)', () => {
  it('marks a template with a stroke as an outline style', () => {
    expect(isOutlineTextTemplate(textTemplateById('outline-impact')!)).toBe(true);
  });

  it('leaves a solid style without a stroke as it is', () => {
    const solid = TEXT_TEMPLATES.find((template) => template.style.stroke === undefined);
    expect(solid).toBeDefined();
    expect(isOutlineTextTemplate(solid!)).toBe(false);
  });

  it('gives an outline tile a mid-grey background', () => {
    const body = ruleBody('.text-template-preview.is-outline');
    expect(body).toMatch(/background:\s*#7d7f89/);
  });
});

describe('template thumbnails (T-D15)', () => {
  it('requests the thumbnail at 240 px, not the old 120 px', () => {
    expect(templatesPanel).toContain('export const TEMPLATE_THUMB_PX = 240;');
    expect(templatesPanel).toContain('getFirstPartySceneThumbUrl(firstSceneId, TEMPLATE_THUMB_PX)');
    expect(templatesPanel).not.toContain('getFirstPartySceneThumbUrl(firstSceneId, 120)');
  });

  it('keeps the whole picture inside the tile with a safe margin', () => {
    expect(ruleBody('.template-card-preview')).toMatch(/padding:\s*var\(--space-3\)/);
    expect(ruleBody('.template-card-preview-img')).toMatch(/object-fit:\s*contain/);
  });
});
