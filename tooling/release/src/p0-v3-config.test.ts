// The release-candidate-v3 P0 config (plan section 3.4). vitest.p0.config.ts inherits the default suite's `projects`, and Vitest then
// runs those projects instead of its own include list: measured, it collects 6,839 default-suite entries and none of the P0 files.
// The v3 config clears the inherited projects and keeps the P0 include list. v2 keeps its own config, unchanged.
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

  it('leaves the v2 P0 config as it was, which still inherits the projects', () => {
    expect(p0V2.test?.projects).toBeDefined();
  });
});
