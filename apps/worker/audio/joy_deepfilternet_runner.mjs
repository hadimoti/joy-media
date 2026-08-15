#!/usr/bin/env node
/**
 * Adapter for the portable DeepFilterNet binary.
 *
 * The Worker invokes this file as: runner <input.wav> <output.wav>. DeepFilter
 * writes to a directory and preserves the input basename, so this adapter keeps
 * that implementation detail out of the job protocol.
 */
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';

const [inputPath, outputPath, ...extra] = process.argv.slice(2);
if (inputPath === undefined || outputPath === undefined || extra.length > 0) {
  throw new Error('Usage: joy_deepfilternet_runner.mjs <input.wav> <output.wav>');
}
if (!existsSync(inputPath)) throw new Error(`DeepFilterNet input is unavailable: ${inputPath}`);

const binary =
  process.env.JOY_MEDIA_DEEPFILTERNET_BINARY?.trim() ||
  join(process.env.JOY_MEDIA_MODEL_ROOT ?? '', 'audio', 'deepfilternet', 'deep-filter.exe');
if (!existsSync(binary)) throw new Error(`DeepFilterNet binary is unavailable: ${binary}`);

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'joy-deepfilternet-'));
try {
  const result = spawnSync(binary, ['-o', temporaryDirectory, inputPath], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `DeepFilterNet failed: ${(result.stderr || result.stdout || '').slice(0, 500)}`,
    );
  }
  const generated = join(temporaryDirectory, basename(inputPath));
  if (!existsSync(generated)) throw new Error('DeepFilterNet did not write its output audio');
  mkdirSync(dirname(outputPath), { recursive: true });
  copyFileSync(generated, outputPath);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
