#!/usr/bin/env node
/* global process, console */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// node:sqlite prints an ExperimentalWarning that AI callers read as trouble. Older Node 22 releases emit it while the CLI
// modules are still being linked, before dist/bin.js can install its own filter, so the same filter runs here first.
// Only that one warning is dropped; every other warning still reaches stderr.
const originalEmit = process.emit;
process.emit = function filteredEmit(event, ...args) {
  const warning = args[0];
  if (
    event === 'warning' &&
    warning instanceof Error &&
    warning.name === 'ExperimentalWarning' &&
    /sqlite/i.test(warning.message)
  ) {
    return false;
  }
  return originalEmit.call(this, event, ...args);
};

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
