import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('transition preview assets', () => {
  it('ships both source frames used by TransitionPreviewCard', () => {
    for (const name of ['transition-preview-frame-a.svg', 'transition-preview-frame-b.svg']) {
      const source = readFileSync(new URL(`../public/assets/${name}`, import.meta.url), 'utf8');
      expect(source.startsWith('<svg')).toBe(true);
      expect(source).toContain('viewBox="0 0 320 180"');
    }
  });
});
