import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Stages the Noto Sans Arabic font folder that the CLI bundle reads, so the installed app has the
 * same layout as apps/cli/dist/fonts/noto-sans-arabic. The bundle looks for its fonts beside
 * joy-media-bundle.mjs, so without this step an installed CLI finds no caption fonts at all.
 *
 * Every pinned file is checked against the length and SHA-256 its manifest records, both before
 * anything is copied and again after the copy. A missing, altered or unexpected file fails the
 * staging, and nothing partial is left behind.
 */

const FONT_LICENSE = 'OFL-1.1';
// Files that no manifest pins. They are checked against their source bytes only.
const UNPINNED_FILES = ['manifest.json', 'LICENSE-OFL.txt', 'libass/manifest.json'];

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function readManifest(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function listFiles(root, prefix = '') {
  const files = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(root, key));
    else if (entry.isFile()) files.push(key);
    else throw new Error(`Noto Sans Arabic font folder has a non-file entry: ${key}`);
  }
  return files.sort();
}

/** Maps each file the folder must hold to the manifest entry that pins it, if one does. */
function pinnedFiles(sourceDirectory) {
  if (!existsSync(join(sourceDirectory, 'manifest.json'))) {
    throw new Error(
      `Noto Sans Arabic font folder is missing at ${sourceDirectory}; run apps/cli/scripts/bundle.mjs first.`,
    );
  }
  const top = readManifest(join(sourceDirectory, 'manifest.json'));
  const libass = readManifest(join(sourceDirectory, 'libass', 'manifest.json'));
  if (top.license !== FONT_LICENSE || libass.license !== FONT_LICENSE) {
    throw new Error(`Noto Sans Arabic font manifests must be ${FONT_LICENSE}`);
  }
  const pinned = new Map(UNPINNED_FILES.map((file) => [file, undefined]));
  for (const entry of top.files) pinned.set(entry.file, entry);
  for (const entry of libass.files) pinned.set(`libass/fonts/${entry.file}`, entry);
  return pinned;
}

/**
 * Copies the font folder to `destinationDirectory`, replacing anything already there, and returns
 * the staged file paths. It throws before copying anything when the source does not match.
 */
export function stageNotoSansArabicFonts({ sourceDirectory, destinationDirectory }) {
  const source = resolve(sourceDirectory);
  const destination = resolve(destinationDirectory);
  const pinned = pinnedFiles(source);
  const found = listFiles(source);
  const missing = [...pinned.keys()].filter((file) => !found.includes(file));
  if (missing.length > 0) {
    throw new Error(`Noto Sans Arabic font folder is missing: ${missing.join(', ')}`);
  }
  const unexpected = found.filter((file) => !pinned.has(file));
  if (unexpected.length > 0) {
    throw new Error(`Noto Sans Arabic font folder has unexpected files: ${unexpected.join(', ')}`);
  }

  // Check every source file before the first copy, so a bad source never leaves a partial stage.
  const digests = new Map();
  for (const [file, entry] of pinned) {
    const bytes = readFileSync(join(source, file));
    const digest = sha256(bytes);
    if (entry !== undefined && (entry.byteLength !== bytes.byteLength || entry.sha256 !== digest)) {
      throw new Error(`${file} does not match its pinned length and digest`);
    }
    digests.set(file, digest);
  }

  rmSync(destination, { recursive: true, force: true });
  const staged = [...pinned.keys()].sort();
  for (const file of staged) {
    const target = join(destination, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, file), target);
    if (sha256(readFileSync(target)) !== digests.get(file)) {
      throw new Error(`${file} failed SHA-256 verification after the copy`);
    }
  }
  return staged;
}
