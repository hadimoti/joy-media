// Merges the Vitest shard reports of one run and checks them against the full test list (plan section 3.4, hosted-verify).
//
//   node tooling/release/src/vitest-shard-merge.mjs --list <vitest-list.json> --reports <folder of shard-*.json> --out <merged.json>
//
// The list is `vitest list --json` from the same commit. Each shard report is `vitest run --shard=i/n --reporter=json`. The merge
// passes only when every listed test ran in exactly one shard, and no shard ran a test the list does not contain. The count of
// listed and executed tests is written to the output, so a dropped test cannot pass unnoticed.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The identity of a test: its file, and its full name as `vitest list` prints it (ancestor titles and the title, joined by " > "). */
export function testKey(file, nameParts) {
  return `${String(file).replace(/\\/gu, '/')}\u0000${nameParts.join(' > ')}`;
}

/** Keys of the tests in a `vitest list --json` array. */
export function listedKeys(list) {
  return list.map((entry) => testKey(entry.file, [entry.name]));
}

/**
 * Keys of the tests a shard report executed, with their status. A shard report is Vitest's JSON reporter output: testResults
 * with a file name and assertionResults with ancestorTitles, title and status.
 */
export function executedKeys(report) {
  const keys = [];
  for (const file of report.testResults ?? []) {
    for (const result of file.assertionResults ?? []) {
      keys.push({
        key: testKey(file.name, [...(result.ancestorTitles ?? []), result.title]),
        status: result.status,
      });
    }
  }
  return keys;
}

/**
 * Merges the shard reports against the list. Returns { ok, listed, executed, missing, duplicated, unexpected, failed }. A test
 * the list names but no shard ran is `missing`; a test two shards ran is `duplicated`; a test no list names is `unexpected`.
 * A failed test is reported in `failed` and fails the merge, because a shard that failed is not evidence.
 */
export function mergeShardReports(list, reports) {
  // A name can appear more than once in one file. Each listed occurrence must run once, so the comparison counts per name.
  const expected = countKeys(listedKeys(list));
  const ran = new Map();
  // The entries that ran to a verdict, per key. A skipped entry is reported with status "skipped" but did not run.
  const verdictCounts = new Map();
  const failed = [];
  for (const report of reports) {
    for (const { key, status } of executedKeys(report)) {
      ran.set(key, (ran.get(key) ?? 0) + 1);
      if (status === 'passed' || status === 'failed') {
        verdictCounts.set(key, (verdictCounts.get(key) ?? 0) + 1);
      }
      if (status === 'failed') failed.push(key);
    }
  }
  const missing = [];
  const duplicated = [];
  for (const [key, count] of expected) {
    const executedCount = ran.get(key) ?? 0;
    if (executedCount < count) missing.push(key);
    if (executedCount > count) duplicated.push(key);
  }
  // A listed test must run to a verdict. A listed entry that was skipped at run time (for example `context.skip()`) is
  // reported as skipped by Vitest and would otherwise count as coverage, so it fails the merge.
  const skippedListed = [...expected.keys()].filter(
    (key) => (ran.get(key) ?? 0) > 0 && (verdictCounts.get(key) ?? 0) < (ran.get(key) ?? 0),
  );
  // A test the collection does not list is unexpected only if it ran. Vitest lists no test skipped by a platform condition
  // (`it.skipIf`), but its JSON report records that test as skipped. Such a test is recorded, and it is not counted as run.
  const unexpected = [...verdictCounts.keys()].filter((key) => !expected.has(key));
  const skippedUnlisted = [...ran.keys()].filter(
    (key) => !expected.has(key) && !verdictCounts.has(key),
  );
  const executed = [...expected.keys()].reduce((sum, key) => sum + (ran.get(key) ?? 0), 0);
  return {
    ok:
      missing.length === 0 &&
      duplicated.length === 0 &&
      unexpected.length === 0 &&
      skippedListed.length === 0 &&
      failed.length === 0,
    listed: list.length,
    executed,
    missing,
    duplicated,
    unexpected,
    skippedListed,
    skippedUnlisted,
    failed,
  };
}

function countKeys(keys) {
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new Error(`Expected --name value pairs, got: ${key}`);
    options[key.slice(2)] = value;
  }
  for (const name of ['list', 'reports', 'out']) {
    if (!options[name]) throw new Error(`Missing --${name}`);
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const list = JSON.parse(readFileSync(resolve(options.list), 'utf8'));
  const reportFiles = readdirSync(resolve(options.reports))
    .filter((name) => /^shard-.*\.json$/u.test(name))
    .sort();
  if (reportFiles.length === 0) throw new Error('No shard-*.json reports were found.');
  const reports = reportFiles.map((name) =>
    JSON.parse(readFileSync(join(resolve(options.reports), name), 'utf8')),
  );
  const merged = mergeShardReports(list, reports);
  writeFileSync(
    resolve(options.out),
    `${JSON.stringify({ shards: reportFiles, ...merged }, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`listed ${merged.listed}, executed ${merged.executed}, ok ${merged.ok}\n`);
  return merged.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
