// Builds the static site into apps/site/dist (Cloudflare Pages output).
//
// Environment:
//   SITE_RELEASE_TAG   release tag the site describes (default v1.1.0)
//   SITE_SHA256SUMS    path to that tag's staged SHA256SUMS.txt. Unset means the hash cells
//                      stay as explicit placeholders, and build.txt says hash_source=placeholder.
//   SITE_COMMIT        site commit recorded in build.txt (default: git HEAD, else "unknown")

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSite } from '../src/render.mjs';
import { assertReleaseTag, parseSha256Sums } from '../src/release.mjs';

const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(siteDir, 'dist');

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: siteDir, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const tag = assertReleaseTag(process.env.SITE_RELEASE_TAG ?? 'v1.1.0');
const commit = process.env.SITE_COMMIT ?? gitHead();

let sums = null;
let sumsSha256 = null;
if (process.env.SITE_SHA256SUMS) {
  const raw = readFileSync(process.env.SITE_SHA256SUMS);
  sums = parseSha256Sums(raw.toString('utf8'), tag);
  sumsSha256 = createHash('sha256').update(raw).digest('hex');
}

const files = renderSite({ tag, commit, sums, sumsSha256 });

rmSync(outDir, { recursive: true, force: true });
for (const [path, contents] of Object.entries(files)) {
  const target = join(outDir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

console.log(
  `site built: ${Object.keys(files).length} files, release ${tag}, hashes ${sums ? 'from SHA256SUMS.txt' : 'PLACEHOLDER (no SHA256SUMS.txt supplied)'}`,
);
