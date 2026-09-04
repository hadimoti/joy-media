import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

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
  'assets/fonts/content-fonts.css',
  'assets/fonts/modam-pro',
  'assets/fonts/yekanbakh',
  'assets/fonts/vazin',
  'assets/fonts/tajrid',
  'assets/fonts/pulad',
  'assets/fonts/damoon',
  'assets/fonts/bon',
  'assets/fonts/bonyadekoodak',
  'assets/fonts/shoor',
  'assets/fonts/aviny',
  'assets/fonts/katibeh',
  'assets/fonts/tahrir',
  'assets/fonts/stencil-898',
  'assets/fonts/radio',
  'assets/fonts/falsafeh',
  'assets/fonts/edameh',
  'assets/fonts/paradox',
  'assets/fonts/gramophone',
  'assets/fonts/emkan-inline',
  'fonts/RooyinFree-Regular.woff2',
  'fonts/RooyinFree-Bold.woff2',
] as const;
const knownFontMarkers = /fontiran|rooyinfree|modam\s*pro|www\.fontiran\.com|mohammad\s+darvishi/i;

const fontsourcePackages = [
  {
    packageName: '@fontsource-variable/inter',
    packageDirectory: '@fontsource-variable/inter',
    family: 'Inter Variable',
    metadataSubsets: ['latin'],
  },
  {
    packageName: '@fontsource-variable/vazirmatn',
    packageDirectory: '@fontsource-variable/vazirmatn',
    family: 'Vazirmatn Variable',
    metadataSubsets: ['arabic', 'latin'],
  },
  {
    packageName: '@fontsource/noto-sans-arabic',
    packageDirectory: '@fontsource/noto-sans-arabic',
    family: 'Noto Sans Arabic',
    metadataSubsets: ['arabic', 'latin', 'latin-ext'],
  },
  {
    packageName: '@fontsource/noto-naskh-arabic',
    packageDirectory: '@fontsource/noto-naskh-arabic',
    family: 'Noto Naskh Arabic',
    metadataSubsets: ['arabic', 'latin', 'latin-ext'],
  },
] as const;

export interface FontAssetScanResult {
  readonly errors: readonly string[];
  readonly scannedFiles: number;
  readonly bundledFontFiles: number;
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

function runtimeFiles(root: string, directories: readonly string[]): string[] {
  return (
    directories
      .flatMap((directory) => walkFiles(resolve(root, directory)))
      .filter((path) => runtimeTextExtensions.has(extname(path).toLowerCase()))
      .filter((path) => !/(?:\.test\.|[\\/]__tests__[\\/])/u.test(path))
      // This module deliberately contains compatibility aliases for projects
      // created before the open-font migration. They are migration data, not
      // shipped assets or an active font reference.
      .filter(
        (path) =>
          !/[\\/]packages[\\/]project-schema[\\/](?:src|dist)[\\/]content-fonts\.(?:ts|js|d\.ts|map)$/u.test(
            path,
          ),
      )
  );
}

function packageRoot(root: string, packageDirectory: string): string {
  return resolve(root, 'apps/editor-web/node_modules', packageDirectory);
}

function checkFontsourceImports(root: string, errors: string[]): void {
  const mainPath = resolve(root, 'apps/editor-web/src/main.tsx');
  if (!existsSync(mainPath)) {
    errors.push('missing editor font entrypoint: apps/editor-web/src/main.tsx');
    return;
  }
  const main = readFileSync(mainPath, 'utf8');
  for (const font of fontsourcePackages) {
    if (
      !main.includes(
        `@fontsource${font.packageName.startsWith('@fontsource-variable') ? '-variable' : ''}`,
      )
    ) {
      errors.push(`missing Fontsource import for ${font.family}`);
    }
    const packagePath = packageRoot(root, font.packageDirectory);
    const metadataPath = join(packagePath, 'metadata.json');
    const packageJsonPath = join(packagePath, 'package.json');
    if (!existsSync(packageJsonPath) || !existsSync(metadataPath)) {
      errors.push(`missing installed Fontsource metadata for ${font.packageName}`);
      continue;
    }
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { license?: string };
      if (packageJson.license !== 'OFL-1.1')
        errors.push(`${font.packageName} is not marked OFL-1.1`);
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
        family?: string;
        subsets?: readonly string[];
        weights?: readonly number[];
        license?: { type?: string };
      };
      const expectedMetadataFamily = font.family.replace(/ Variable$/u, '');
      if (metadata.family !== expectedMetadataFamily)
        errors.push(`${font.packageName} family metadata mismatch`);
      for (const subset of font.metadataSubsets) {
        if (!metadata.subsets?.includes(subset))
          errors.push(`${font.packageName} metadata is missing ${subset} subset`);
      }
      if (metadata.license?.type !== 'OFL-1.1')
        errors.push(`${font.packageName} metadata does not declare OFL-1.1`);
      if ((metadata.weights?.length ?? 0) === 0) errors.push(`${font.packageName} has no weights`);
    } catch {
      errors.push(`invalid Fontsource metadata for ${font.packageName}`);
    }
  }

  // Keep the imported subset CSS/assets in lockstep with the package metadata.
  for (const match of main.matchAll(
    /@fontsource\/(noto-(?:sans|naskh)-arabic)\/(arabic|latin|latin-ext)-(400|700)\.css/gu,
  )) {
    const packageDirectory = `@fontsource/${match[1]}`;
    const cssPath = join(packageRoot(root, packageDirectory), `${match[2]}-${match[3]}.css`);
    if (!existsSync(cssPath))
      errors.push(`missing imported subset CSS: ${packageDirectory}/${match[2]}-${match[3]}.css`);
  }
  const catalogPath = resolve(root, 'packages/project-schema/src/content-fonts.ts');
  const catalog = existsSync(catalogPath) ? readFileSync(catalogPath, 'utf8') : '';
  for (const family of ['Noto Sans Arabic', 'Noto Naskh Arabic']) {
    const entryStart = catalog.indexOf(`family: '${family}'`);
    const entry =
      entryStart < 0 ? '' : catalog.slice(entryStart, catalog.indexOf('},', entryStart) + 2);
    for (const subset of ['Arabic', 'Latin']) {
      if (!entry.includes(subset))
        errors.push(`${family} catalog metadata is missing ${subset} coverage`);
    }
  }
}

/**
 * Scan every shipped editor font surface and runtime text surface. This is
 * intentionally dependency-free so release:gate can run it before or after
 * Vitest and cannot accidentally be skipped by test-file selection.
 */
export function scanFontAssets(root: string): FontAssetScanResult {
  const errors: string[] = [];
  const publicRoot = resolve(root, 'apps/editor-web/public');
  for (const target of legacyTargets) {
    if (existsSync(join(publicRoot, target))) errors.push(`retired font asset present: ${target}`);
  }
  const publicFontFiles = walkFiles(publicRoot).filter((path) =>
    shippedFontExtensions.has(extname(path).toLowerCase()),
  );
  for (const path of publicFontFiles) {
    if (knownFontMarkers.test(readFileSync(path).toString('latin1')))
      errors.push(`font ownership marker in public asset: ${relative(root, path)}`);
  }
  const htmlPath = resolve(root, 'apps/editor-web/index.html');
  if (existsSync(htmlPath) && knownFontMarkers.test(readFileSync(htmlPath, 'utf8')))
    errors.push('retired font marker in editor index.html');

  const files = [
    ...runtimeFiles(root, runtimeSourceRoots),
    ...runtimeFiles(root, runtimeDistRoots),
  ];
  for (const path of files) {
    if (knownFontMarkers.test(readFileSync(path, 'utf8')))
      errors.push(`font ownership marker in runtime file: ${relative(root, path)}`);
  }
  checkFontsourceImports(root, errors);
  const licenseRoot = resolve(publicRoot, 'licenses/fonts');
  const licensePath = join(licenseRoot, 'OFL-1.1.txt');
  const attributionPath = join(licenseRoot, 'FONT-ATTRIBUTIONS.md');
  if (!existsSync(licensePath))
    errors.push('missing bundled font license: apps/editor-web/public/licenses/fonts/OFL-1.1.txt');
  else if (!readFileSync(licensePath, 'utf8').includes('SIL OPEN FONT LICENSE Version 1.1'))
    errors.push('bundled OFL license text is incomplete');
  if (!existsSync(attributionPath)) errors.push('missing bundled font attribution manifest');
  else {
    const attribution = readFileSync(attributionPath, 'utf8');
    for (const font of fontsourcePackages) {
      if (!attribution.includes(font.packageName))
        errors.push(`font attribution missing ${font.packageName}`);
    }
  }
  return { errors, scannedFiles: files.length, bundledFontFiles: publicFontFiles.length };
}
