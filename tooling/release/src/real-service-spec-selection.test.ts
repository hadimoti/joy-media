import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { specsReachingControlPort } from './control-port-reach.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const HARNESS = readFileSync(
  join(ROOT, 'ops/self-hosted/linux-runner/real-service-acceptance.mjs'),
  'utf8',
);
const E2E_DIRECTORY = join(ROOT, 'tests/e2e');
const CONTROL_HELPER = join(E2E_DIRECTORY, 'helpers', 'control-port.ts');

// The set the harness leaves out of its desktop-primary run, read from its source.
function excludedSpecs(): string[] {
  const block = HARNESS.match(/EXCLUDED_DESKTOP_PRIMARY_SPECS = new Set\(\[([^\]]*)\]\)/u);
  if (!block) throw new Error('the harness no longer declares EXCLUDED_DESKTOP_PRIMARY_SPECS');
  return Array.from(block[1]!.matchAll(/'([^']+\.spec\.ts)'/gu), (match) => match[1]!);
}

describe('real-service desktop-primary spec selection', () => {
  it('leaves out the P3 matrix spec and the synthetic account spec, and nothing else', () => {
    expect(excludedSpecs().sort()).toEqual([
      'r2-p3-shipping-export-acceptance.spec.ts',
      'synthetic-account-session.spec.ts',
    ]);
  });

  it('leaves out every spec that needs the synthetic E2E control port, directly or through an import', () => {
    // Those specs name JOY_MEDIA_E2E_CONTROL_TOKEN, or import tests/e2e/helpers/control-port.ts, directly or
    // through other imports. That server runs only in the fixture-only browser lane, so against real services
    // such a spec can only fail with a refused connection, after the lane has already spent most of an hour.
    const needsControlPort = specsReachingControlPort(E2E_DIRECTORY, CONTROL_HELPER);
    expect(needsControlPort).toContain('synthetic-account-session.spec.ts');
    for (const name of needsControlPort) expect(excludedSpecs()).toContain(name);
  });

  it('follows imports transitively and leaves out only the specs that reach the port', () => {
    const root = mkdtempSync(join(tmpdir(), 'control-port-reach-'));
    try {
      mkdirSync(join(root, 'helpers'));
      writeFileSync(
        join(root, 'helpers', 'control-port.ts'),
        "export const CONTROL = 'control';\n",
      );
      writeFileSync(
        join(root, 'helpers', 'middle.ts'),
        "export { CONTROL } from './control-port.js';\n",
      );
      writeFileSync(join(root, 'helpers', 'unrelated.ts'), 'export const other = 1;\n');
      writeFileSync(
        join(root, 'via-helper.spec.ts'),
        "import { CONTROL } from './helpers/middle.js';\n",
      );
      writeFileSync(
        join(root, 'via-literal.spec.ts'),
        "const name = 'JOY_MEDIA_E2E_CONTROL_TOKEN';\n",
      );
      writeFileSync(
        join(root, 'unrelated.spec.ts'),
        "import { other } from './helpers/unrelated.js';\n",
      );
      expect(specsReachingControlPort(root, join(root, 'helpers', 'control-port.ts'))).toEqual([
        'via-helper.spec.ts',
        'via-literal.spec.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still selects every other top-level spec by filtering on the exclusion set', () => {
    expect(HARNESS).toContain('!EXCLUDED_DESKTOP_PRIMARY_SPECS.has(entry.name)');
    expect(HARNESS).toContain("entry.name.endsWith('.spec.ts')");
  });
});
