#!/usr/bin/env node
/* global console, process */
/**
 * Scene package CLI wrapper. Reads a .joyscene package directory and prints the
 * compile report. All logic lives in `validateScenePackage`; this only does I/O.
 *
 *   joy-scene <package-dir>
 *
 * Expects scene.json (manifest), optional schema.json, optional variables.json,
 * and the entry source referenced by the manifest's `entry` field.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isScenePackagePath, validateScenePackage } from '../dist/index.js';

function readOptional(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

const dir = resolve(process.argv[2] ?? '.');
const manifestPath = join(dir, 'scene.json');
if (!existsSync(manifestPath)) {
  console.error(`joy-scene: no scene.json in ${dir}`);
  process.exit(2);
}

const manifest = readFileSync(manifestPath, 'utf8');
let entry;
try {
  const candidate = JSON.parse(manifest).entry;
  entry = isScenePackagePath(candidate, '.js') ? candidate : undefined;
} catch {
  // validateScenePackage reports the malformed manifest; do not read any path.
}
const sourcePath = entry === undefined ? undefined : join(dir, entry);
const source =
  sourcePath !== undefined && existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : '';

const report = validateScenePackage({
  manifest,
  source,
  schema: readOptional(join(dir, 'schema.json')),
  variables: readOptional(join(dir, 'variables.json')),
});

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
