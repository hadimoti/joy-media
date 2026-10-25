import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Counts where literal values appear under a folder. An attended session uses it to show that a
 * typed secret, account identifier or one-time code never reached the evidence folder or the profile
 * logs. Only counts leave this module. The values and the text around them are never returned, and
 * matches are found in both UTF-8 and UTF-16LE, because Windows logs are often UTF-16.
 */
export interface LeakScanResult {
  readonly filesScanned: number;
  /** Matches per value, in the order the values were given. */
  readonly matchesByValue: readonly number[];
  readonly total: number;
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function countOccurrences(haystack: Buffer, needle: Buffer): number {
  let count = 0;
  let offset = haystack.indexOf(needle);
  while (offset !== -1) {
    count += 1;
    offset = haystack.indexOf(needle, offset + needle.length);
  }
  return count;
}

/** Counts every occurrence of each non-empty value under `root`, with no value text in the result. */
export function scanForLiteralValues(root: string, values: readonly string[]): LeakScanResult {
  const files = filesUnder(root);
  const matchesByValue = values.map(() => 0);
  for (const file of files) {
    const content = readFileSync(file);
    values.forEach((value, index) => {
      if (value.length === 0) return;
      const utf8 = countOccurrences(content, Buffer.from(value, 'utf8'));
      const utf16 = countOccurrences(content, Buffer.from(value, 'utf16le'));
      matchesByValue[index] = (matchesByValue[index] ?? 0) + utf8 + utf16;
    });
  }
  return {
    filesScanned: files.length,
    matchesByValue,
    total: matchesByValue.reduce((sum, count) => sum + count, 0),
  };
}
