import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTENT_FONT_CATALOG } from '../../../packages/project-schema/src/content-fonts.js';
import { scanFontAssets } from './font-assets.js';

const editorRoot = fileURLToPath(new URL('../../../apps/editor-web/', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const publicFontRoot = fileURLToPath(
  new URL('../../../apps/editor-web/public/assets/fonts/', import.meta.url),
);
const publicRoot = fileURLToPath(new URL('../../../apps/editor-web/public/', import.meta.url));
const distRoot = fileURLToPath(new URL('../../../apps/editor-web/dist/', import.meta.url));
const loginGateCss = fileURLToPath(
  new URL('../../../apps/editor-web/src/login-gate.css', import.meta.url),
);
const mainEntry = fileURLToPath(new URL('../../../apps/editor-web/src/main.tsx', import.meta.url));
const knownFontMarkers = /fontiran|rooyinfree|modam\s*pro|www\.fontiran\.com|mohammad\s+darvishi/i;
const shippedFontExtensions = new Set(['.woff', '.woff2', '.ttf', '.otf']);
const runtimeTextExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.map',
  '.mjs',
  '.ts',
  '.tsx',
]);
const runtimeSourceRoots = [
  'apps/editor-web/src',
  'apps/api/src',
  'apps/worker/src',
  'packages/project-schema/src',
  'packages/visual-object-renderer/src',
  'packages/motion-core/src',
] as const;
const runtimeDistRoots = [
  'apps/editor-web/dist',
  'apps/api/dist',
  'apps/worker/dist',
  'packages/project-schema/dist',
  'packages/visual-object-renderer/dist',
  'packages/motion-core/dist',
] as const;
const legacyTargets = [
  'content-fonts.css',
  'modam-pro',
  'yekanbakh',
  'vazin',
  'tajrid',
  'pulad',
  'damoon',
  'bon',
  'bonyadekoodak',
  'shoor',
  'aviny',
  'katibeh',
  'tahrir',
  'stencil-898',
  'radio',
  'falsafeh',
  'edameh',
  'paradox',
  'gramophone',
  'emkan-inline',
  'fonts/RooyinFree-Regular.woff2',
  'fonts/RooyinFree-Bold.woff2',
] as const;

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

function readBinaryForMarkers(path: string): string {
  return readFileSync(path).toString('latin1');
}

function runtimeFiles(roots: readonly string[]): string[] {
  return (
    roots
      .flatMap((root) => walkFiles(join(repositoryRoot, root)))
      .filter((path) => runtimeTextExtensions.has(extname(path).toLowerCase()))
      .filter((path) => !/(?:\.test\.|[\\/]__tests__[\\/])/u.test(path))
      // This module deliberately contains compatibility aliases for projects
      // created before the open-font migration. They are migration data, not
      // shipped assets or an active font reference.
      .filter(
        (path) =>
          !/packages[\\/]project-schema[\\/](?:src|dist)[\\/]content-fonts\.(?:ts|js|d\.ts|map)$/u.test(
            path,
          ),
      )
  );
}

describe('editor font redistribution gate', () => {
  it('is clean through the same scanner used by release:gate', () => {
    const result = scanFontAssets(repositoryRoot);
    expect(result.errors).toEqual([]);
    expect(result.scannedFiles).toBeGreaterThan(0);
  }, 15_000);

  it('contains no retired Fontiran runtime assets or aggregator', () => {
    const present = legacyTargets.filter((target) => {
      try {
        readdirSync(`${publicFontRoot}${target}`);
        return true;
      } catch {
        try {
          readFileSync(`${publicFontRoot}${target}`);
          return true;
        } catch {
          return false;
        }
      }
    });
    expect(present).toEqual([]);

    const html = readFileSync(`${editorRoot}index.html`, 'utf8');
    expect(html).not.toMatch(/fontiran|modam|content-fonts\.css/i);
    expect(readFileSync(loginGateCss, 'utf8')).not.toMatch(knownFontMarkers);
    expect(readFileSync(mainEntry, 'utf8')).not.toMatch(knownFontMarkers);

    const publicFontFiles = walkFiles(publicRoot).filter((path) =>
      shippedFontExtensions.has(extname(path).toLowerCase()),
    );
    expect(publicFontFiles.map((path) => relative(publicRoot, path))).toEqual([]);
    for (const path of publicFontFiles) {
      expect(readBinaryForMarkers(path), relative(publicRoot, path)).not.toMatch(knownFontMarkers);
    }
  });

  it('keeps every bundled Fontsource family on OFL-1.1 with checked-in attribution', () => {
    const packageNames = CONTENT_FONT_CATALOG.map(
      (font) => font.source.match(/@fontsource[^)]+/)?.[0],
    ).filter((name): name is string => name !== undefined);
    expect(packageNames).toHaveLength(4);
    for (const packageName of packageNames) {
      const manifest = JSON.parse(
        readFileSync(`${editorRoot}node_modules/${packageName}/package.json`, 'utf8'),
      ) as { license?: string };
      expect(manifest.license).toBe('OFL-1.1');
    }

    const licensePath = `${publicRoot}licenses/fonts/OFL-1.1.txt`;
    const attributionPath = `${publicRoot}licenses/fonts/FONT-ATTRIBUTIONS.md`;
    const license = readFileSync(licensePath, 'utf8');
    const attributions = readFileSync(attributionPath, 'utf8');
    expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(attributions).toContain('OFL-1.1');
    for (const packageName of packageNames) expect(attributions).toContain(packageName);

    const builtLicense = `${distRoot}licenses/fonts/OFL-1.1.txt`;
    const builtAttributions = `${distRoot}licenses/fonts/FONT-ATTRIBUTIONS.md`;
    // Only a completed Vite build (index.html emitted) is the shipped artifact;
    // a stale or partial dist left on a persistent CI runner is not. A real
    // build that drops the font licenses still fails this assertion.
    if (existsSync(`${distRoot}index.html`)) {
      expect(readFileSync(builtLicense, 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
      expect(readFileSync(builtAttributions, 'utf8')).toContain('OFL-1.1');
    }
  });

  it('regresses the retired RooyinFree login paths explicitly', () => {
    expect(existsSync(`${publicRoot}fonts/RooyinFree-Regular.woff2`)).toBe(false);
    expect(existsSync(`${publicRoot}fonts/RooyinFree-Bold.woff2`)).toBe(false);
    expect(readFileSync(loginGateCss, 'utf8')).not.toMatch(/RooyinFree|Rooyin|\/fonts\//i);
  });

  it('scans the final Vite artifact for ownership markers when it exists', () => {
    // Guard on a completed build, not any leftover dist on a persistent runner.
    if (!existsSync(`${distRoot}index.html`)) return;
    const builtFiles = walkFiles(distRoot);
    const builtFontFiles = builtFiles.filter((path) =>
      shippedFontExtensions.has(extname(path).toLowerCase()),
    );
    expect(builtFontFiles.length).toBeGreaterThan(0);
    for (const path of builtFiles) {
      const extension = extname(path).toLowerCase();
      if (
        !['.css', '.html', '.js', '.map', '.mjs', '.json', ...shippedFontExtensions].includes(
          extension,
        )
      ) {
        continue;
      }
      expect(readBinaryForMarkers(path), relative(distRoot, path)).not.toMatch(knownFontMarkers);
    }
  });

  it('scans application runtime source and every generated runtime surface', () => {
    const sourceFiles = runtimeFiles(runtimeSourceRoots);
    expect(sourceFiles.length).toBeGreaterThan(0);
    for (const path of sourceFiles) {
      expect(readFileSync(path, 'utf8'), relative(repositoryRoot, path)).not.toMatch(
        knownFontMarkers,
      );
    }

    const generatedFiles = runtimeFiles(runtimeDistRoots);
    for (const path of generatedFiles) {
      expect(readBinaryForMarkers(path), relative(repositoryRoot, path)).not.toMatch(
        knownFontMarkers,
      );
    }
  });
});
