// The release-candidate-v3 P0 config (plan section 3.4). Vitest runs the default suite's `projects` instead of the include list of a config
// that spreads them: measured before the fix, vitest.p0.config.ts collected 6,865 default-suite entries in 738 files. The v3 config
// clears the inherited projects and keeps the P0 include list. The v2 config clears them the same way, so v2 and v3 run the same P0 files.
import { describe, expect, it } from 'vitest';
import p0V3 from '../../../vitest.p0-v3.config.ts';
import p0V2 from '../../../vitest.p0.config.ts';

describe('the release-candidate-v3 P0 config', () => {
  it('clears the inherited projects, so its own include list decides what runs', () => {
    expect(p0V3.test?.projects).toBeUndefined();
  });

  it('runs only the P0 files, one worker at a time', () => {
    expect(p0V3.test?.maxWorkers).toBe(1);
    expect(p0V3.test?.include).toEqual(
      expect.arrayContaining([
        'tooling/golden-render/src/first-party-scenes.test.ts',
        'apps/cli/src/commands/render-*.test.ts',
        'apps/cli/src/**/*title*.test.ts',
      ]),
    );
    expect(p0V3.test?.include).not.toContain('{apps,packages,tooling}/**/src/**/*.test.{ts,tsx}');
    expect(p0V3.test?.passWithNoTests).toBe(false);
  });

  it('clears the inherited projects in the v2 P0 config too, so v2 runs the same P0 include list as v3', () => {
    expect(p0V2.test?.projects).toBeUndefined();
    expect(p0V2.test?.maxWorkers).toBe(1);
    expect(p0V2.test?.include).toEqual(p0V3.test?.include);
  });
});
