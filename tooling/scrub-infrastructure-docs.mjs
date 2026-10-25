// One-off scrub of infrastructure detail from the documentation in docs/ and plan/ (plan item F3). It replaces owner
// profile paths, private key file names, server logins and paths, and non-allowlisted IPv4 addresses with placeholders.
// Without --write it only counts. The git history keeps the original text; the scan in tests enforces the current tree.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRUB_ROOTS = ['docs', 'plan'];
const EXTENSIONS = new Set(['.md', '.json', '.txt', '.yml', '.yaml']);
const ALLOWED_IPV4 = new Set(['127.0.0.1', '0.0.0.0', '1.1.1.1', '8.8.8.8', '10.0.26100.1']);

const REPLACEMENTS = [
  [/C:\\\\Users\\\\[A-Za-z0-9._-]+/gu, '<owner-profile>'],
  [/C:\\Users\\[A-Za-z0-9._-]+/gu, '<owner-profile>'],
  [/\/c\/Users\/[A-Za-z0-9._-]+/gu, '<owner-profile>'],
  [/Users\/HadiMoti/gu, '<owner-profile>'],
  [/[A-Za-z0-9._-]*(?:Joy-Vps-New|joy-vps|iran[12]-vps)\.pem/giu, '<vps-key-file>'],
  [/root@/gu, '<vps-user>@'],
  [/\/root\//gu, '<vps-home>/'],
  [/\/opt\/joy-/gu, '<vps-app-root>/joy-'],
];
const IPV4 = /(?<![0-9.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9.])/gu;

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile() && EXTENSIONS.has(extname(entry.name))) yield path;
  }
}

function scrub(text) {
  let replaced = 0;
  let next = text;
  for (const [pattern, replacement] of REPLACEMENTS) {
    next = next.replace(pattern, () => {
      replaced += 1;
      return replacement;
    });
  }
  next = next.replace(IPV4, (match) => {
    if (ALLOWED_IPV4.has(match)) return match;
    replaced += 1;
    return '<host-ip>';
  });
  return { next, replaced };
}

const write = process.argv.includes('--write');
let files_ = 0;
let total = 0;
for (const root of SCRUB_ROOTS) {
  for (const path of files(join(repoRoot, root))) {
    const original = readFileSync(path, 'utf8');
    const { next, replaced } = scrub(original);
    if (replaced === 0) continue;
    files_ += 1;
    total += replaced;
    if (write) writeFileSync(path, next, 'utf8');
  }
}
console.log(`${write ? 'scrubbed' : 'would scrub'} ${total} occurrence(s) in ${files_} file(s)`);
