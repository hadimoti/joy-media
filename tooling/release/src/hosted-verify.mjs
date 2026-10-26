// Hosted verification for release-candidate-v3 (plan section 3.4, hosted-verify). Three Vitest shards run in parallel on
// hosted Ubuntu. A merge job then checks that the shards together executed every test the collection lists, exactly once,
// with no failures, and runs the static release commands once on the same commit. The final gate reads one report that is
// bound to this candidate, run and attempt. The gate refuses any report that is incomplete, failed, duplicated, retried or
// from another run.
//
//   node --experimental-strip-types tooling/release/src/hosted-verify.mjs merge --list <list.json> --reports <dir> --out <merge.json>
//   node --experimental-strip-types tooling/release/src/hosted-verify.mjs commands --out <commands.json>
//   node --experimental-strip-types tooling/release/src/hosted-verify.mjs assemble --merge <merge.json> --commands <commands.json> \
//       --candidate-sha <sha> --run-id <id> --run-attempt <n> --out <report.json>
//   node --experimental-strip-types tooling/release/src/hosted-verify.mjs verify --report <report.json> \
//       --candidate-sha <sha> --run-id <id> --run-attempt <n>
//
// The test identity matches ci-v3-equivalence.ts (repo-relative file, then the full name), so a v3 report and a v2 JSON
// report compare on the same IDs. hosted-verify.test.ts pins that equality.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listedKeys, mergeShardReports, testKey } from './vitest-shard-merge.mjs';

export const REPORT_FORMAT = 'joy-media-hosted-verify';
export const SHARD_COUNT = 3;
// The static release commands, run once here on the exact commit. The final gate takes their exit codes from this report
// instead of running them again on the acceptance runner. The builds stay in the gate, because the gate needs the built
// output on disk. Each command is the gate's own command (tooling/release/src/gate.ts RELEASE_COMMANDS), with retries off.
export const HOSTED_COMMANDS = [
  ['typecheck', ['typecheck']],
  ['lint', ['lint']],
  ['format', ['format:check']],
  ['goldens', ['exec', 'vitest', 'run', '--retry=0', 'tooling/golden-render/src']],
];
export const REQUIRED_COMMAND_IDS = HOSTED_COMMANDS.map(([id]) => id);
const REPO_DIRECTORIES = ['/apps/', '/packages/', '/tooling/', '/tests/', '/ops/', '/docs/'];
const EXECUTED_STATUSES = ['passed', 'failed', 'skipped', 'pending', 'todo'];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function repoRelative(path) {
  const normalized = String(path).replace(/\\/gu, '/');
  for (const directory of REPO_DIRECTORIES) {
    const index = normalized.indexOf(directory);
    if (index >= 0) return normalized.slice(index + 1);
  }
  return normalized;
}

/** The test ID of one Vitest JSON assertion. Matches summarizeVitestJsonReport in ci-v3-equivalence.ts. */
export function testIdOf(file, fullName) {
  return `${repoRelative(file)}::${fullName}`;
}

/** Every assertion a shard report holds: its merge key (matched against the collection), its report ID, and its status. */
function assertionsOf(report) {
  const assertions = [];
  for (const file of report.testResults ?? []) {
    for (const result of file.assertionResults ?? []) {
      const parts = [...(result.ancestorTitles ?? []), result.title];
      const fullName = typeof result.fullName === 'string' ? result.fullName : parts.join(' ');
      assertions.push({
        key: testKey(file.name, parts),
        id: testIdOf(file.name, fullName),
        status: result.status,
      });
    }
  }
  return assertions;
}

/** Every assertion a shard report holds, with its ID and status. A test listed twice in one file appears twice. */
export function executedTests(report) {
  return assertionsOf(report).map(({ id, status }) => ({ id, status }));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Merges the shard reports against the collection. The result carries the counts the gate needs and the executed tests with
 * their IDs. A listed test no shard ran is `missing`; one two shards ran is `duplicated`; one the collection does not name is
 * `unexpected`; a failed test fails the merge.
 */
export function mergeShards({ list, reports, shards }) {
  const merged = mergeShardReports(list, reports);
  const display = (key) => key.replace('\u0000', ' :: ');
  const listed = new Set(listedKeys(list));
  const assertions = reports.flatMap((report) => assertionsOf(report));
  // The executed list holds the listed tests only, so its length is the merge's count of listed tests. A test the collection
  // does not list and that Vitest skipped by a platform condition is recorded separately, and is not counted as executed.
  const executedTests = assertions
    .filter(({ key }) => listed.has(key))
    .map(({ id, status }) => ({ id, status }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const skippedUnlisted = assertions
    .filter(({ key, status }) => !listed.has(key) && status !== 'passed' && status !== 'failed')
    .map(({ id }) => id)
    .sort();
  return {
    ok: merged.ok,
    listed: merged.listed,
    executed: merged.executed,
    missing: merged.missing.map(display),
    duplicated: merged.duplicated.map(display),
    unexpected: merged.unexpected.map(display),
    skippedListed: merged.skippedListed.map(display),
    skippedUnlisted,
    failed: merged.failed.map(display),
    shards,
    executedTests,
  };
}

/** Runs the static release commands on this checkout and records each exit code. Output goes to the job log. */
export function runHostedCommands({ root, runner = spawnSync }) {
  return HOSTED_COMMANDS.map(([id, args]) => {
    const started = Date.now();
    // On Windows pnpm is a .cmd shim, which only a shell can launch, as in the gate's own command runner.
    const result = runner('pnpm', args, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    return {
      id,
      command: ['pnpm', ...args].join(' '),
      exitCode: result.status ?? 1,
      durationMs: Date.now() - started,
    };
  });
}

/** Assembles the report from a merge result and the command results. The result is not yet verified. */
export function assembleReport({ candidateSha, runId, runAttempt, merge, commands }) {
  return {
    schemaVersion: 1,
    format: REPORT_FORMAT,
    candidateSha,
    runId: String(runId),
    attempt: Number(runAttempt),
    list: { count: merge.listed, sha256: merge.listSha256 },
    shards: merge.shards,
    merge: {
      ok: merge.ok,
      listed: merge.listed,
      executed: merge.executed,
      missing: merge.missing,
      duplicated: merge.duplicated,
      unexpected: merge.unexpected,
      skippedListed: merge.skippedListed,
      // Tests Vitest skipped by a platform condition, which the collection does not list. Recorded, not counted as executed.
      skippedUnlisted: merge.skippedUnlisted,
      failed: merge.failed,
    },
    commands,
    testSummary: { collected: merge.executed, failed: merge.failed.length },
    executed: merge.executedTests,
  };
}

/**
 * Verifies one report against the candidate, run and attempt the gate expects. Returns { ok, reasons, commandResults,
 * testSummary, executedIds, failedIds }. Every reason names one rule that failed. The gate records the reasons and fails
 * closed when any are present.
 */
export function verifyReport(report, expected) {
  const reasons = [];
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return refusedInputs(['the hosted-verify report is not a JSON object']);
  }
  if (report.schemaVersion !== 1) reasons.push('the hosted-verify report schema is not version 1');
  if (report.format !== REPORT_FORMAT) reasons.push('the hosted-verify report format is unknown');
  if (!/^[0-9a-f]{40}$/u.test(expected.candidateSha ?? '')) {
    reasons.push('the expected candidate SHA is invalid');
  } else if (report.candidateSha !== expected.candidateSha) {
    reasons.push('the hosted-verify report names a different candidate SHA');
  }
  if (String(report.runId) !== String(expected.runId)) {
    reasons.push('the hosted-verify report names a different workflow run');
  }
  if (String(expected.runAttempt) !== '1' || report.attempt !== 1) {
    reasons.push('the hosted-verify report is not from the first attempt; a re-run proves nothing');
  }

  const merge = report.merge ?? {};
  for (const name of ['missing', 'duplicated', 'unexpected', 'skippedListed', 'failed']) {
    if (!Array.isArray(merge[name]) || merge[name].length > 0) {
      reasons.push(`the Vitest merge reports ${name} tests`);
    }
  }
  if (merge.ok !== true) reasons.push('the Vitest shard merge did not pass');
  if (!Number.isInteger(merge.listed) || merge.listed < 1) {
    reasons.push('the Vitest collection is empty or unreadable');
  }
  if (merge.executed !== merge.listed) {
    reasons.push(
      `the shards executed ${String(merge.executed)} tests, but the collection lists ${String(merge.listed)}`,
    );
  }
  if (report.list?.count !== merge.listed) {
    reasons.push('the recorded collection size does not match the merge');
  }
  if (!Array.isArray(report.shards) || report.shards.length !== SHARD_COUNT) {
    reasons.push(`the report does not hold exactly ${SHARD_COUNT} Vitest shards`);
  } else if (
    report.shards.some((shard) => !/^[0-9a-f]{64}$/u.test(shard?.sha256 ?? '')) ||
    report.shards.some((shard) => !(shard?.tests > 0))
  ) {
    reasons.push('a Vitest shard has no digest or ran no tests');
  }

  const commands = Array.isArray(report.commands) ? report.commands : [];
  const commandResults = [];
  for (const id of REQUIRED_COMMAND_IDS) {
    const matches = commands.filter((command) => command?.id === id);
    if (matches.length !== 1) {
      reasons.push(`the static command ${id} is missing or repeated`);
    } else if (matches[0].exitCode !== 0) {
      reasons.push(`the static command ${id} exited ${String(matches[0].exitCode)}`);
    } else {
      commandResults.push({
        id,
        command: matches[0].command,
        exitCode: 0,
        durationMs: matches[0].durationMs,
      });
    }
  }

  const executed = Array.isArray(report.executed) ? report.executed : [];
  if (executed.length !== merge.executed) {
    reasons.push('the executed-test list does not match the merge count');
  }
  if (executed.some((test) => !EXECUTED_STATUSES.includes(test?.status))) {
    reasons.push('the executed-test list holds an unknown status');
  }
  if (executed.some((test) => test?.status === 'failed')) {
    reasons.push('the executed-test list holds a failed test');
  }
  const testSummary = report.testSummary ?? {};
  if (testSummary.collected !== merge.executed || testSummary.failed !== 0) {
    reasons.push('the test summary does not match the merge');
  }

  if (reasons.length > 0) return refusedInputs(reasons);
  commandResults.push({
    id: 'tests',
    command: `vitest run ${SHARD_COUNT} shards, merged against the collection`,
    exitCode: 0,
    durationMs: 0,
  });
  return {
    ok: true,
    reasons: [],
    commandResults,
    testSummary: { collected: merge.executed, failed: 0 },
    // Only a test that ran to a verdict counts as executed, as in ci-v3-equivalence.ts. A skipped test does not.
    executedIds: executed
      .filter((test) => test.status === 'passed' || test.status === 'failed')
      .map((test) => test.id),
    failedIds: [],
  };
}

export function refusedInputs(reasons) {
  // A refused report still yields the gate's failing inputs, so the gate's own checks fail with the reasons on record.
  return {
    ok: false,
    reasons,
    commandResults: [
      ...REQUIRED_COMMAND_IDS.map((id) => ({ id, command: id, exitCode: 1, durationMs: 0 })),
      { id: 'tests', command: 'vitest run (refused)', exitCode: 1, durationMs: 0 },
    ],
    testSummary: { collected: 0, failed: 1 },
    executedIds: [],
    failedIds: [],
  };
}

/** The report's bytes and their digest, for the job output the gate checks. */
export function reportBytes(report) {
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { bytes, sha256: sha256(bytes) };
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
  return options;
}

function required(options, names) {
  for (const name of names) {
    if (!options[name]) throw new Error(`Missing --${name}`);
  }
}

function runMerge(options) {
  required(options, ['list', 'reports', 'out']);
  const listBytes = readFileSync(resolve(options.list));
  const list = JSON.parse(listBytes.toString('utf8'));
  if (!Array.isArray(list))
    throw new Error('The collection must be a JSON array (vitest list --json).');
  const reportsDir = resolve(options.reports);
  const names = readdirSync(reportsDir)
    .filter((name) => /^shard-[1-9][0-9]*\.json$/u.test(name))
    .sort();
  if (names.length !== SHARD_COUNT) {
    throw new Error(`Expected ${SHARD_COUNT} shard reports, found ${names.length}.`);
  }
  const reports = names.map((name) => readJson(join(reportsDir, name)));
  const shards = names.map((name, index) => ({
    name,
    sha256: sha256(readFileSync(join(reportsDir, name))),
    tests: executedTests(reports[index]).length,
  }));
  const merge = mergeShards({ list, reports, shards });
  const out = {
    ...merge,
    listSha256: sha256(listBytes),
  };
  writeFileSync(resolve(options.out), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `merged ${merge.executed} executed of ${merge.listed} listed: ok ${merge.ok}\n`,
  );
  return merge.ok ? 0 : 1;
}

function runCommands(options) {
  required(options, ['out']);
  const commands = runHostedCommands({ root: process.cwd() });
  writeFileSync(resolve(options.out), `${JSON.stringify(commands, null, 2)}\n`, 'utf8');
  const failed = commands.filter((command) => command.exitCode !== 0).map((command) => command.id);
  process.stdout.write(
    `static commands: ${failed.length === 0 ? 'all passed' : `failed ${failed.join(', ')}`}\n`,
  );
  return failed.length === 0 ? 0 : 1;
}

function runAssemble(options) {
  required(options, ['merge', 'commands', 'candidate-sha', 'run-id', 'run-attempt', 'out']);
  const merge = readJson(resolve(options.merge));
  const commands = readJson(resolve(options.commands));
  const report = assembleReport({
    candidateSha: options['candidate-sha'],
    runId: options['run-id'],
    runAttempt: options['run-attempt'],
    merge,
    commands,
  });
  const verdict = verifyReport(report, {
    candidateSha: options['candidate-sha'],
    runId: options['run-id'],
    runAttempt: options['run-attempt'],
  });
  const { bytes } = reportBytes(report);
  writeFileSync(resolve(options.out), bytes);
  if (!verdict.ok) {
    process.stderr.write(`hosted-verify report refused:\n  - ${verdict.reasons.join('\n  - ')}\n`);
    return 1;
  }
  process.stdout.write(`hosted-verify report verified: ${verdict.testSummary.collected} tests\n`);
  return 0;
}

function runVerify(options) {
  required(options, ['report', 'candidate-sha', 'run-id', 'run-attempt']);
  const verdict = verifyReport(readJson(resolve(options.report)), {
    candidateSha: options['candidate-sha'],
    runId: options['run-id'],
    runAttempt: options['run-attempt'],
  });
  if (!verdict.ok) {
    process.stderr.write(`hosted-verify report refused:\n  - ${verdict.reasons.join('\n  - ')}\n`);
    return 1;
  }
  process.stdout.write(`hosted-verify report verified: ${verdict.testSummary.collected} tests\n`);
  return 0;
}

function main(argv) {
  const [mode, ...rest] = argv;
  const options = parseArgs(rest);
  if (mode === 'merge') return runMerge(options);
  if (mode === 'commands') return runCommands(options);
  if (mode === 'assemble') return runAssemble(options);
  if (mode === 'verify') return runVerify(options);
  throw new Error('usage: hosted-verify.mjs <merge|commands|assemble|verify> --name value ...');
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
