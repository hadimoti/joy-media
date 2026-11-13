#!/usr/bin/env node
/* global console */
/**
 * Regenerates `src/catalog.ts` and `src/glsl-sources.ts` from `src/catalog.json` and the vendored
 * `.glsl` files in `src/shaders/`. Shader sources are committed files; nothing is fetched here.
 *
 *   node packages/transition-shaders/scripts/generate-sources.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(packageRoot, 'src');
const catalog = JSON.parse(readFileSync(resolve(srcDir, 'catalog.json'), 'utf8'));

function literal(value) {
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  const body = Object.entries(value)
    .map(
      ([key, item]) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : literal(key)}: ${literal(item)}`,
    )
    .join(',\n');
  return body === '' ? '{}' : `{\n${body},\n}`;
}

async function writeFormatted(file, source) {
  const options = (await prettier.resolveConfig(file)) ?? {};
  writeFileSync(file, await prettier.format(source, { ...options, filepath: file }));
}

const files = [...new Set(catalog.map((row) => row.glslFile))];
const sources = files.map((file) => {
  const text = readFileSync(resolve(srcDir, 'shaders', file), 'utf8').replace(/\r\n/g, '\n');
  return `  ${literal(file)}: ${JSON.stringify(text)},`;
});

await writeFormatted(
  resolve(srcDir, 'catalog.ts'),
  `/** Auto-generated catalog. Edit catalog.json, then run scripts/generate-sources.mjs. */\nexport const TRANSITION_CATALOG = ${literal(catalog)} as const;\n`,
);
await writeFormatted(
  resolve(srcDir, 'glsl-sources.ts'),
  `/** Auto-generated from the vendored .glsl files (gl-transitions, MIT, plus JOY Media's own dips). Do not edit by hand; run scripts/generate-sources.mjs. */\nexport const TRANSITION_GLSL_BY_FILE: Readonly<Record<string, string>> = {\n${sources.join('\n')}\n} as const;\n`,
);
console.log(
  `transition-shaders: ${catalog.length} catalogue entries, ${files.length} shader files`,
);
