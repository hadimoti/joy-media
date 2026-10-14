#!/usr/bin/env node
/* global process, console */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distBin = join(__dirname, '..', 'dist', 'bin.js');

if (existsSync(distBin)) {
  // Install the SQLite warning filter in its OWN import, before the CLI's module graph is
  // resolved. On some Node 22.x releases (22.15-22.17 at least) `node:sqlite`'s warning is queued
  // while the graph is still being linked, i.e. before any CLI module body (including the filter
  // imported first by bin.ts) has run, so relying on import order alone leaks it to stderr.
  const filter = join(__dirname, '..', 'dist', 'process-warnings.js');
  if (existsSync(filter)) await import(pathToFileURL(filter).href);
  // pathToFileURL (not string concatenation) so install paths containing
  // '#', '%', '?' or spaces still resolve. dist/bin.js runs the CLI itself.
  await import(pathToFileURL(distBin).href);
} else {
  console.error('JOY Media CLI is not built yet. Run: pnpm --filter @joy-media/cli build');
  process.exit(1);
}
