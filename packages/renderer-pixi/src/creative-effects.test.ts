import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('creative blur filters', () => {
  it('keeps every advertised creative blur wired to a fragment program', () => {
    const source = readFileSync(new URL('./creative-effects.ts', import.meta.url), 'utf8');
    for (const [kind, program] of [
      ['zoom-blur', 'ZOOM_BLUR_FRAG'],
      ['radial-blur', 'RADIAL_BLUR_FRAG'],
      ['tilt-shift', 'TILT_SHIFT_FRAG'],
    ] as const) {
      expect(source).toContain(`case '${kind}':`);
      expect(source).toContain(program);
    }
  });
});
