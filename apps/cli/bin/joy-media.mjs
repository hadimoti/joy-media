#!/usr/bin/env node
/* global process */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distBin = join(__dirname, '..', 'dist', 'bin.js');

if (existsSync(distBin)) {
  await import(`file://${distBin.replace(/\\/g, '/')}`);
} else {
  // If not yet compiled, run directly via TypeScript loader or dynamic import
  try {
    const srcBin = join(__dirname, '..', 'src', 'bin.ts');
    // Use tsx or strip-types if available
    const { main } = await import(`file://${srcBin.replace(/\\/g, '/')}`);
    await main(process.argv.slice(2));
  } catch (error) {
    console.error('JOY Media CLI: Please build first via `pnpm --filter @joy-media/cli build`');
    console.error(error);
    process.exit(1);
  }
}
