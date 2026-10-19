import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { builtinModules } from 'node:module';

const esbuildPath = resolve(
  import.meta.dirname,
  '../../../node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/lib/main.js',
);
const { build } = await import(`file://${esbuildPath.replace(/\\/g, '/')}`);

const nodeExternals = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

const cliRoot = resolve(import.meta.dirname, '..');
const fontSource = resolve(
  cliRoot,
  '..',
  '..',
  'packages',
  'html-scene-runtime',
  'assets',
  'fonts',
  'noto-sans-arabic',
);
const fontOutput = resolve(cliRoot, 'dist', 'fonts', 'noto-sans-arabic');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const expectedFontFiles = new Set([
  'noto-sans-arabic-arabic-400-normal.woff2',
  'noto-sans-arabic-arabic-700-normal.woff2',
  'noto-sans-arabic-latin-400-normal.woff2',
  'noto-sans-arabic-latin-700-normal.woff2',
]);

function copyVerified(file) {
  const source = resolve(fontSource, file);
  const destination = resolve(fontOutput, file);
  copyFileSync(source, destination);
  const sourceHash = hash(readFileSync(source));
  const destinationHash = hash(readFileSync(destination));
  if (sourceHash !== destinationHash) {
    throw new Error(`Bundled font asset copy failed SHA-256 verification: ${file}`);
  }
}

await build({
  entryPoints: [resolve(cliRoot, 'src', 'bin.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: resolve(cliRoot, 'dist', 'joy-media-bundle.mjs'),
  packages: 'bundle',
  banner: {
    js: `#!/usr/bin/env node
import { createRequire as __createRequire } from "node:module";
const require = __createRequire(import.meta.url);
`,
  },
  external: nodeExternals,
});

mkdirSync(fontOutput, { recursive: true });
const fontManifest = JSON.parse(readFileSync(resolve(fontSource, 'manifest.json'), 'utf8'));
if (
  fontManifest.files.length !== expectedFontFiles.size ||
  fontManifest.files.some((entry) => !expectedFontFiles.has(entry.file))
) {
  throw new Error('Noto Sans Arabic font manifest must list exactly the four bundled WOFF2 files');
}
for (const entry of fontManifest.files) {
  const sourceBytes = readFileSync(resolve(fontSource, entry.file));
  if (
    sourceBytes.byteLength !== entry.byteLength ||
    `sha256:${hash(sourceBytes)}` !== entry.sha256
  ) {
    throw new Error(`Source font asset failed manifest verification: ${entry.file}`);
  }
  copyVerified(entry.file);
}
for (const file of ['manifest.json', 'LICENSE-OFL.txt']) copyVerified(file);

console.log('Successfully bundled @joy-media/cli and verified its Noto Sans Arabic fonts');
