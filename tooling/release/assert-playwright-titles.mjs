#!/usr/bin/env node
/* global process, console */
/**
 * Assert that a Playwright JSON report contains EACH given spec title, and that
 * every occurrence PASSED. A minimum count cannot prove the intended tests ran
 * (a bad --grep could match the wrong 3 tests); this checks identity.
 *
 * Usage: assert-playwright-titles.mjs <report.json> "<title 1>" "<title 2>" ...
 * Exit 0 = all present + passed; exit 1 otherwise (details on stderr).
 */
import { readFileSync } from 'node:fs';

const [reportPath, ...required] = process.argv.slice(2);
if (!reportPath || required.length === 0) {
  console.error('usage: assert-playwright-titles.mjs <report.json> "<title>" ["<title>" ...]');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`cannot read/parse Playwright report ${reportPath}: ${error.message}`);
  process.exit(1);
}

/** title -> { ran: n, passed: n } */
const seen = new Map();
const walk = (suites) => {
  if (!Array.isArray(suites)) return;
  for (const suite of suites) {
    for (const spec of suite.specs ?? []) {
      const title = String(spec.title ?? '');
      for (const test of spec.tests ?? []) {
        const last =
          Array.isArray(test.results) && test.results.length > 0 ? test.results.at(-1) : null;
        const status = last?.status ?? test.outcome ?? 'unknown';
        const rec = seen.get(title) ?? { ran: 0, passed: 0 };
        rec.ran += 1;
        if (status === 'passed' || status === 'expected') rec.passed += 1;
        seen.set(title, rec);
      }
    }
    walk(suite.suites);
  }
};
walk(report.suites);

const problems = [];
for (const title of required) {
  const rec = seen.get(title);
  if (!rec || rec.ran === 0) problems.push(`NOT RUN: "${title}"`);
  else if (rec.passed !== rec.ran)
    problems.push(`ran ${rec.ran}, passed ${rec.passed}: "${title}"`);
}

if (problems.length > 0) {
  console.error(`Playwright title-identity check FAILED for ${reportPath}:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    `  (titles seen: ${[...seen.keys()].map((t) => JSON.stringify(t)).join(', ') || 'none'})`,
  );
  process.exit(1);
}
console.log(`title-identity OK — ${required.length} required test(s) ran and passed`);
