import { resolve } from 'node:path';
import { builtinModules } from 'node:module';

const esbuildPath = resolve(import.meta.dirname, '../../../node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/lib/main.js');
const { build } = await import(`file://${esbuildPath.replace(/\\/g, '/')}`);

const nodeExternals = [
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`)
];

const cliRoot = resolve(import.meta.dirname, '..');

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
`
  },
  external: nodeExternals
});

console.log('Successfully bundled @joy-media/cli to dist/joy-media-bundle.mjs');
