// The release-candidate-v3 P0 config (plan section 3.4). When the default suite declares `projects`, vitest.p0.config.ts inherits them,
// and Vitest then runs those projects instead of its own include list: measured on the development branch, that collects 6,839
// default-suite entries and none of the P0 files. The v3 config clears any inherited projects and keeps the P0 include list.
// v2 keeps its own config, so vitest.p0.config.ts is pinned to its checksum.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import p0V3 from '../../../vitest.p0-v3.config.ts';

// The sha256 of vitest.p0.config.ts on main when this suite landed. release-candidate-v2 runs that file, so it stays byte-identical.
const V2_P0_SHA256 = '474672a48362c9775f1e7d789b325438aa6bfef1f694b67f55b19bc77f289fe4';

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

  it('leaves the v2 P0 config as it was', () => {
    const bytes = readFileSync(new URL('../../../vitest.p0.config.ts', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(V2_P0_SHA256);
  });
});
