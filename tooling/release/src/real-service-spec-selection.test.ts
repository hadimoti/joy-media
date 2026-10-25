import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const HARNESS = readFileSync(
  join(ROOT, 'ops/self-hosted/linux-runner/real-service-acceptance.mjs'),
  'utf8',
);
const E2E_DIRECTORY = join(ROOT, 'tests/e2e');

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

  it('leaves out every spec that needs the synthetic E2E control port', () => {
    // Those specs read JOY_MEDIA_E2E_CONTROL_TOKEN and call the control port that tooling/e2e-server.ts
    // opens. That server runs only in the fixture-only browser lane, so against real services such a spec
    // can only fail with a refused connection, after the lane has already spent most of an hour.
    const needsControlPort = readdirSync(E2E_DIRECTORY)
      .filter((name) => name.endsWith('.spec.ts'))
      .filter((name) =>
        readFileSync(join(E2E_DIRECTORY, name), 'utf8').includes('JOY_MEDIA_E2E_CONTROL_TOKEN'),
      );
    expect(needsControlPort.length).toBeGreaterThan(0);
    for (const name of needsControlPort) expect(excludedSpecs()).toContain(name);
  });

  it('still selects every other top-level spec by filtering on the exclusion set', () => {
    expect(HARNESS).toContain('!EXCLUDED_DESKTOP_PRIMARY_SPECS.has(entry.name)');
    expect(HARNESS).toContain("entry.name.endsWith('.spec.ts')");
  });
});
