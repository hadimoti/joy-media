import { describe, expect, it } from 'vitest';
import { compileScenePackage } from './compile.js';
import { createStarterScenePackage, starterManifest } from './template.js';

describe('compileScenePackage', () => {
  it('compiles the starter package with a CSP and a deterministic reference frame', () => {
    const compiled = compileScenePackage(createStarterScenePackage());
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.csp).toContain("default-src 'none'");
    expect(compiled.csp).toContain("connect-src 'none'");
    expect(compiled.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(compiled.referenceFrameSha256).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic: compiling again yields the identical frame hash.
    const again = compileScenePackage(createStarterScenePackage());
    expect(again.referenceFrameSha256).toBe(compiled.referenceFrameSha256);
  });

  it('applies variable overrides and defaults', () => {
    const pkg = createStarterScenePackage();
    const compiled = compileScenePackage({ ...pkg, variables: { title: 'Big Sale' } });
    expect(compiled.variables.title).toBe('Big Sale');
    expect(compiled.variables.accent).toBe('#e9b949'); // default
  });

  it('changing a variable changes the reference frame', () => {
    const pkg = createStarterScenePackage();
    const a = compileScenePackage({ ...pkg, variables: { title: 'One' } });
    const b = compileScenePackage({ ...pkg, variables: { title: 'Two' } });
    expect(a.referenceFrameSha256).not.toBe(b.referenceFrameSha256);
  });

  it('flags a network API used without a network permission', () => {
    const compiled = compileScenePackage({
      manifest: starterManifest(),
      source: 'globalThis.__joyScene = function () { fetch("https://x"); return null; };',
    });
    expect(compiled.diagnostics.some((d) => d.code === 'SCENE_COMPILE_NETWORK')).toBe(true);
    expect(compiled.referenceFrameSha256).toBeUndefined();
  });

  it('emits connect-src origins and skips the reference render for a networked scene', () => {
    const compiled = compileScenePackage({
      manifest: starterManifest({
        permissions: { network: ['https://cdn.example.com'], storage: 'none' },
      }),
      source: 'globalThis.__joyScene = function (ctx) { return null; };',
    });
    expect(compiled.csp).toContain('connect-src https://cdn.example.com');
    expect(compiled.referenceFrameSha256).toBeUndefined();
  });

  it('records a render failure as a diagnostic instead of throwing', () => {
    const compiled = compileScenePackage({
      manifest: starterManifest(),
      source: 'globalThis.__joyScene = function () { return 42; };', // not a React element
    });
    expect(compiled.diagnostics.some((d) => d.code === 'SCENE_COMPILE_RENDER')).toBe(true);
  });

  it('omits the CSP when the manifest is invalid', () => {
    const compiled = compileScenePackage({
      manifest: starterManifest({ id: '' }),
      source: 'globalThis.__joyScene = function () { return null; };',
    });
    expect(compiled.csp).toBeUndefined();
    expect(compiled.diagnostics.some((d) => d.code === 'SCENE_MANIFEST_ID')).toBe(true);
  });
});
