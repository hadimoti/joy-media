/**
 * Builds lightweight, square effect-preview loops from a supplied source folder.
 *
 * Usage:
 *   pnpm exec tsx tooling/generate-effect-motion-previews.mts <source-video-folder>
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, relative, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const sourceRoot = process.argv[2];
const outputDirectory = resolve(repo, 'apps/editor-web/public/effects/preview-motion');
const videoExtensions = new Set(['.mp4', '.mov', '.webm']);

if (sourceRoot === undefined || !existsSync(sourceRoot)) {
  throw new Error('Pass the prepared source-video folder as the first argument.');
}

function findVideos(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return findVideos(path);
      return entry.isFile() && videoExtensions.has(extname(entry.name).toLowerCase()) ? [path] : [];
    })
    .sort((left, right) => left.localeCompare(right));
}

const sourceVideos = findVideos(sourceRoot);
if (sourceVideos.length === 0) throw new Error(`No video files found in ${sourceRoot}.`);

mkdirSync(outputDirectory, { recursive: true });

for (const [index, source] of sourceVideos.entries()) {
  const outputName = `joy-motion-${String(index + 1).padStart(2, '0')}.webm`;
  const output = resolve(outputDirectory, outputName);
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-stream_loop',
      '-1',
      '-i',
      source,
      '-ss',
      '0.06',
      '-t',
      '2.4',
      '-an',
      '-vf',
      'fps=12,scale=192:192:force_original_aspect_ratio=increase,crop=192:192',
      '-c:v',
      'libvpx-vp9',
      '-pix_fmt',
      'yuv420p',
      '-b:v',
      '0',
      '-crf',
      '37',
      '-deadline',
      'good',
      '-cpu-used',
      '4',
      '-row-mt',
      '1',
      '-y',
      output,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error(`Failed to generate ${outputName}.`);
  console.log(`${outputName} <- ${relative(sourceRoot, source)}`);
}

console.log(`Generated ${sourceVideos.length} motion previews in ${outputDirectory}.`);
