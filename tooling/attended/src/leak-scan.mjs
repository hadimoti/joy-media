// Counts how often secret literals appear in the files of an attended session, and never prints them.
//
// The owner types each literal (an email, a one-time code, an API key) into a file outside the repository, one per line.
// The scan reports only counts per literal position. The literal text is never written to stdout, stderr or the report,
// so the report can be stored with the receipt. A zero count is evidence only for the files that were scanned.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * @param {{ roots: string[], literals: string[] }} options
 * @returns {{ filesScanned: number, filesSkipped: number, literalCount: number, counts: number[], literalFingerprints: string[] }}
 */
export function scanForLiterals({ roots, literals }) {
  const values = literals.map((literal) => literal.trim()).filter((literal) => literal.length > 0);
  if (values.length === 0)
    throw new Error('No literals were given, so the scan would prove nothing.');
  const counts = values.map(() => 0);
  const stats = { filesScanned: 0, filesSkipped: 0 };
  for (const root of roots) {
    for (const file of listFiles(resolve(root))) {
      const size = statSync(file).size;
      if (size > MAX_FILE_BYTES) {
        stats.filesSkipped += 1;
        continue;
      }
      const bytes = readFileSync(file);
      stats.filesScanned += 1;
      // Each literal is matched in its UTF-8 form and in its UTF-16LE form, because logs and browser stores differ.
      values.forEach((value, index) => {
        counts[index] += countOccurrences(bytes, Buffer.from(value, 'utf8'));
        counts[index] += countOccurrences(bytes, Buffer.from(value, 'utf16le'));
      });
    }
  }
  return {
    ...stats,
    literalCount: values.length,
    counts,
    // A digest identifies which literal a count belongs to without revealing the literal.
    literalFingerprints: values.map((value) =>
      createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16),
    ),
  };
}

/** Reads one literal per line from a file the owner keeps outside the repository. */
export function readLiteralFile(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
}

export function hasLeak(result) {
  return result.counts.some((count) => count > 0);
}

function listFiles(root) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function main(args) {
  const rootIndex = args.indexOf('--root');
  const literalIndex = args.indexOf('--literals');
  if (rootIndex < 0 || literalIndex < 0) {
    process.stderr.write(
      'usage: leak-scan.mjs --root <folder> [--root <folder>]... --literals <file outside the repo>\n',
    );
    return 2;
  }
  const roots = args
    .flatMap((arg, index) => (arg === '--root' ? [args[index + 1]] : []))
    .filter(Boolean);
  const literals = readLiteralFile(args[literalIndex + 1]);
  const result = scanForLiterals({ roots, literals });
  // Only counts and fingerprints leave this process.
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return hasLeak(result) ? 1 : 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
