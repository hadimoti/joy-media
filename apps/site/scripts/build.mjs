// Builds the static site into apps/site/dist (Cloudflare Pages output).
//
// Environment:
//   SITE_RELEASE_TAG   release tag the site describes (default v1.1.0)
//   SITE_SHA256SUMS    path to that tag's staged SHA256SUMS.txt. Unset: the committed copy in
//                      apps/site/release/<tag>/SHA256SUMS.txt is used, and if that is missing too the hash
//                      cells stay as explicit placeholders (build.txt says hash_source=placeholder).
// Argument:
//   --out <dir>        output folder (default apps/site/dist)
//   SITE_COMMIT        site commit recorded in build.txt (default: git HEAD, else "unknown")

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSite } from '../src/render.mjs';
import { assertReleaseTag, parseSha256Sums } from '../src/release.mjs';

const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// `--out <dir>` writes the site somewhere else (relative to the current folder). apps/account-web uses it so that
// its `build` script, which the VPS deploy script (deploy-control-plane.sh) runs and copies to the joyst.ir
// web root, publishes this landing page and not the old account page.
const outFlag = process.argv.indexOf('--out');
const outDir =
  outFlag >= 0 && process.argv[outFlag + 1]
    ? resolve(process.cwd(), process.argv[outFlag + 1])
    : join(siteDir, 'dist');

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
// Without SITE_SHA256SUMS, use the published SHA256SUMS.txt of this tag that is committed next to the site
// (apps/site/release/<tag>/SHA256SUMS.txt), so a build on any machine shows real hashes, never placeholders.
const committedSums = join(siteDir, 'release', tag, 'SHA256SUMS.txt');
const sumsPath = process.env.SITE_SHA256SUMS ?? (existsSync(committedSums) ? committedSums : null);
if (sumsPath) {
  const raw = readFileSync(sumsPath);
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

// A plain nginx (the joyst.ir host) serves /download as /download/index.html, while Cloudflare Pages
// serves it from download.html. Write both, from the same text, so every host resolves the clean paths.
for (const [path, contents] of Object.entries(files)) {
  if (!path.endsWith('.html') || path === 'index.html' || path === '404.html') continue;
  const target = join(outDir, path.slice(0, -'.html'.length), 'index.html');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

// Static images (real screenshots of the app) are copied as they are.
cpSync(join(siteDir, 'assets'), outDir, { recursive: true });

console.log(
  `site built: ${Object.keys(files).length} files, release ${tag}, hashes ${sums ? 'from SHA256SUMS.txt' : 'PLACEHOLDER (no SHA256SUMS.txt supplied)'}`,
);
