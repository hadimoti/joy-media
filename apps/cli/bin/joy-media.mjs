#!/usr/bin/env node
/* global process, console */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distBin = join(__dirname, '..', 'dist', 'bin.js');

if (existsSync(distBin)) {
  // pathToFileURL (not string concatenation) so install paths containing
  // '#', '%', '?' or spaces still resolve. dist/bin.js runs the CLI itself.
  await import(pathToFileURL(distBin).href);
} else {
  console.error('JOY Media CLI is not built yet. Run: pnpm --filter @joy-media/cli build');
  process.exit(1);
}
