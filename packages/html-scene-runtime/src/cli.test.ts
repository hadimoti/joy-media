import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateScenePackage } from './cli.js';
import { createStarterScenePackage } from './template.js';

function starterFiles(overrides: Partial<Record<string, string>> = {}) {
  const pkg = createStarterScenePackage();
  return {
    manifest: JSON.stringify(pkg.manifest),
    schema: JSON.stringify(pkg.variableSchema),
    source: pkg.source,
    ...overrides,
  };
}

describe('validateScenePackage', () => {
  it('reports a clean, compilable starter package', () => {
    const report = validateScenePackage(starterFiles());
    expect(report.ok).toBe(true);
    expect(report.manifestId).toBe('joy.firstparty.starter-title');
    expect(report.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.csp).toContain("default-src 'none'");
    expect(report.referenceFrameSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.diagnostics).toEqual([]);
  });

  it('fails on malformed manifest JSON', () => {
    const report = validateScenePackage(starterFiles({ manifest: '{ not json' }));
    expect(report.ok).toBe(false);
    expect(report.diagnostics.some((d) => d.code === 'SCENE_PACKAGE_JSON')).toBe(true);
  });

  it('applies a variables override file', () => {
    const report = validateScenePackage(
      starterFiles({ variables: JSON.stringify({ title: 'Launch' }) }),
    );
    expect(report.ok).toBe(true);
  });

  it('reports manifest violations from the package', () => {
    const pkg = createStarterScenePackage();
    const report = validateScenePackage({
      manifest: JSON.stringify({ ...pkg.manifest, durationUs: 0 }),
      schema: JSON.stringify(pkg.variableSchema),
      source: pkg.source,
    });
    expect(report.ok).toBe(false);
    expect(report.diagnostics.some((d) => d.code === 'SCENE_MANIFEST_DURATION')).toBe(true);
  });

  it('runs the built CLI against a real package directory', () => {
    const pkg = createStarterScenePackage();
    const directory = mkdtempSync(join(tmpdir(), 'joy-scene-package-'));
    mkdirSync(join(directory, 'dist'));
    writeFileSync(join(directory, 'scene.json'), JSON.stringify(pkg.manifest));
    writeFileSync(join(directory, 'schema.json'), JSON.stringify(pkg.variableSchema));
    writeFileSync(join(directory, 'dist', 'index.js'), pkg.source);

    const bin = fileURLToPath(new URL('../bin/joy-scene.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [bin, directory], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      manifestId: 'joy.firstparty.starter-title',
    });
  });
});
