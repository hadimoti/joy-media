import { describe, expect, it } from 'vitest';
import { resolveMotionStudioFontFamily } from './font-family.js';

describe('Motion Studio font fallback', () => {
  it('keeps an omitted layer family on the declared system-ui fallback', () => {
    expect(resolveMotionStudioFontFamily(undefined)).toBe('system-ui');
  });

  it('still maps a persisted legacy family to the bundled replacement', () => {
    expect(resolveMotionStudioFontFamily('YekanBakh')).toBe('Vazirmatn Variable');
  });
});
