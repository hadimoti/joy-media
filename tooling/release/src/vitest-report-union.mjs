// Merges the Vitest JSON reports of one release-candidate-v2 run into one report of the same shape (plan section 3.4, D18).
//
//   node tooling/release/src/vitest-report-union.mjs --out <union.json> <lane-report.json> [<lane-report.json> ...]
//
// v2 writes no per-test report of its own. Its test lanes write Vitest JSON reports (`--reporter=json --outputFile.json=...`), and this
// tool merges them so ci-v3-run-inputs.mjs can name the tests the run executed. Each test is kept once, by the report ID the equivalence
// tool uses, so a test that two lanes ran appears once. A failure in any lane stays a failure, and the builder refuses a union that has
// one. A lane report without test results stops the merge.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testIdOf } from './hosted-verify.mjs';

// A verdict in one lane outranks a skip in another, and a failure outranks everything.
const RANK = { failed: 4, passed: 3, pending: 2, todo: 1 };

/** Merges lane reports into one Vitest JSON report: one entry per test ID, with the counts the builder reads. */
export function unionReports(reports) {
  const byId = new Map();
  reports.forEach((report, index) => {
    if (report === null || typeof report !== 'object' || !Array.isArray(report.testResults)) {
      throw new Error(`lane report ${index + 1} has no test results`);
    }
    for (const file of report.testResults) {
      for (const result of file.assertionResults ?? []) {
        const ancestorTitles = result.ancestorTitles ?? [];
        const fullName =
          typeof result.fullName === 'string'
            ? result.fullName
            : [...ancestorTitles, result.title].join(' ');
        const id = testIdOf(file.name, fullName);
        const previous = byId.get(id);
        if (previous === undefined || (RANK[result.status] ?? 0) > (RANK[previous.status] ?? 0)) {
          byId.set(id, {
            file: file.name,
            ancestorTitles,
            title: result.title,
            fullName,
            status: result.status,
          });
        }
      }
    }
  });

  const groups = new Map();
  for (const entry of byId.values()) {
    if (!groups.has(entry.file)) groups.set(entry.file, []);
    groups.get(entry.file).push(entry);
  }
  const testResults = [...groups].map(([name, entries]) => ({
    name,
    status: entries.some((entry) => entry.status === 'failed') ? 'failed' : 'passed',
    assertionResults: entries.map(({ ancestorTitles, title, fullName, status }) => ({
      ancestorTitles,
      title,
      fullName,
      status,
    })),
  }));

  const statuses = [...byId.values()].map((entry) => entry.status);
  const count = (status) => statuses.filter((value) => value === status).length;
  return {
    numTotalTests: statuses.length,
    numPassedTests: count('passed'),
    numFailedTests: count('failed'),
    numPendingTests: count('pending'),
    numTodoTests: count('todo'),
    success: count('failed') === 0,
    testResults,
  };
}

function parseArgs(argv) {
  const options = { out: undefined, reports: [] };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') {
      options.out = argv[index + 1];
      index += 1;
    } else {
      options.reports.push(argv[index]);
    }
  }
  if (options.out === undefined) throw new Error('Missing --out');
  if (options.reports.length === 0) throw new Error('No lane reports were given');
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const reports = options.reports.map((path) => JSON.parse(readFileSync(resolve(path), 'utf8')));
  const union = unionReports(reports);
  writeFileSync(resolve(options.out), `${JSON.stringify(union, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `lanes ${reports.length}, tests ${union.numTotalTests}, passed ${union.numPassedTests}, failed ${union.numFailedTests}\n`,
  );
  return union.numFailedTests === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
