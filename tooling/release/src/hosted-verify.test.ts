// Tests for the hosted-verify merge, command and report rules (plan section 3.4, hosted-verify). Every rule the final gate
// relies on has a negative control here: a missing, duplicated, failed or unknown test, a failed static command, a report
// from another candidate, run or attempt, and a report whose bytes were changed after it was assembled.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { summarizeVitestJsonReport } from './ci-v3-equivalence.ts';
import {
  assembleReport,
  executedTests,
  HOSTED_COMMANDS,
  mergeShards,
  REQUIRED_COMMAND_IDS,
  reportBytes,
  runHostedCommands,
  testIdOf,
  verifyReport,
} from './hosted-verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, 'hosted-verify.mjs');
const SHA = 'a'.repeat(40);
const RUN = '40400000001';
const DIGEST = 'b'.repeat(64);
const FILE_A = 'C:/repo/apps/a/src/a.test.ts';
const FILE_B = 'C:/repo/packages/b/src/b.test.ts';
const FILE_C = 'C:/repo/tooling/c/src/c.test.ts';

// One file per shard, so every shard runs at least one test, as a real shard does.
const list = [
  { name: 'suite > passes', file: FILE_A, projectName: 'parallel' },
  { name: 'suite > also passes', file: FILE_A, projectName: 'parallel' },
  { name: 'standalone passes', file: FILE_B, projectName: 'serial-process' },
  { name: 'waits for later', file: FILE_B, projectName: 'serial-process' },
  { name: 'third shard passes', file: FILE_C, projectName: 'parallel' },
];

type Row = [string[], string, string];

function assertions(file: string, rows: Row[]) {
  return {
    name: file,
    assertionResults: rows.map(([ancestorTitles, title, status]) => ({
      ancestorTitles,
      title,
      fullName: [...ancestorTitles, title].join(' '),
      status,
    })),
  };
}

const shardOne = {
  testResults: [
    assertions(FILE_A, [
      [['suite'], 'passes', 'passed'],
      [['suite'], 'also passes', 'passed'],
    ]),
  ],
};
const shardTwo = {
  testResults: [
    assertions(FILE_B, [
      [[], 'standalone passes', 'passed'],
      [[], 'waits for later', 'passed'],
    ]),
  ],
};
const shardThree = {
  testResults: [assertions(FILE_C, [[[], 'third shard passes', 'passed']])],
};

function mergeOf(reports = [shardOne, shardTwo, shardThree], collection = list) {
  return mergeShards({
    list: collection,
    reports,
    shards: reports.map((_, index) => ({
      name: `shard-${index + 1}.json`,
      sha256: DIGEST,
      tests: executedTests(reports[index]).length,
    })),
  });
}

function passingReport() {
  const merge = { ...mergeOf(), listSha256: DIGEST };
  const commands = HOSTED_COMMANDS.map(([id, args]) => ({
    id,
    command: ['pnpm', ...args].join(' '),
    exitCode: 0,
    durationMs: 1,
  }));
  return assembleReport({
    candidateSha: SHA,
    runId: RUN,
    runAttempt: '1',
    merge,
    commands,
  });
}

const EXPECTED = { candidateSha: SHA, runId: RUN, runAttempt: '1' };

describe('test identity', () => {
  it('matches the ID that ci-v3-equivalence.ts gives the same Vitest assertion', () => {
    const report = {
      testResults: [
        {
          name: 'C:\\repo\\apps\\a\\src\\a.test.ts',
          assertionResults: [
            {
              ancestorTitles: ['suite'],
              title: 'passes',
              fullName: 'suite passes',
              status: 'passed',
            },
          ],
        },
      ],
    };
    const fromEquivalence = [...summarizeVitestJsonReport(report).executed];
    expect(executedTests(report).map((test) => test.id)).toEqual(fromEquivalence);
    expect(testIdOf('/home/runner/work/joy-media/apps/a/src/a.test.ts', 'suite passes')).toBe(
      'apps/a/src/a.test.ts::suite passes',
    );
  });
});

describe('merge against the collection', () => {
  it('passes when the shards together execute every listed test exactly once', () => {
    const merged = mergeOf();
    expect(merged).toMatchObject({
      ok: true,
      listed: 5,
      executed: 5,
      missing: [],
      duplicated: [],
      unexpected: [],
      failed: [],
    });
    expect(merged.executedTests).toHaveLength(5);
  });

  it('refuses a listed test that no shard ran', () => {
    const dropped = mergeOf([
      { testResults: [assertions(FILE_A, [[['suite'], 'passes', 'passed']])] },
      shardTwo,
      shardThree,
    ]);
    expect(dropped.ok).toBe(false);
    expect(dropped.missing).toEqual(['C:/repo/apps/a/src/a.test.ts :: suite > also passes']);
  });

  it('refuses a test that two shards both executed', () => {
    const duplicated = mergeOf([shardOne, shardTwo, shardOne]);
    expect(duplicated.ok).toBe(false);
    expect(duplicated.duplicated).toHaveLength(2);
  });

  it('refuses a test the collection does not name', () => {
    const invented = assertions(FILE_A, [[['suite'], 'invented', 'passed']]);
    const merged = mergeOf([shardOne, shardTwo, { testResults: [invented] }]);
    expect(merged.ok).toBe(false);
    expect(merged.unexpected).toEqual(['C:/repo/apps/a/src/a.test.ts :: suite > invented']);
  });

  it('refuses a failed test even when every test ran', () => {
    const failing = assertions(FILE_B, [
      [[], 'standalone passes', 'failed'],
      [[], 'waits for later', 'skipped'],
    ]);
    const merged = mergeOf([shardOne, { testResults: [failing] }, shardThree]);
    expect(merged.ok).toBe(false);
    expect(merged.failed).toEqual(['C:/repo/packages/b/src/b.test.ts :: standalone passes']);
    expect(merged.missing).toEqual([]);
  });

  it('refuses a listed test that was skipped at run time, and names it', () => {
    const skipped = assertions(FILE_B, [
      [[], 'standalone passes', 'passed'],
      [[], 'waits for later', 'skipped'],
    ]);
    const merged = mergeOf([shardOne, { testResults: [skipped] }, shardThree]);
    expect(merged.ok).toBe(false);
    expect(merged.skippedListed).toEqual(['C:/repo/packages/b/src/b.test.ts :: waits for later']);
  });
});

describe('the hosted-verify report', () => {
  it('verifies a complete, passing report for the expected candidate, run and attempt', () => {
    const verdict = verifyReport(passingReport(), EXPECTED);
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.testSummary).toEqual({ collected: 5, failed: 0 });
    expect(verdict.commandResults.map((command) => command.id)).toEqual([
      ...REQUIRED_COMMAND_IDS,
      'tests',
    ]);
    // The executed list is sorted by ID, so the report's order is stable across runs.
    expect(verdict.executedIds).toEqual([
      'apps/a/src/a.test.ts::suite also passes',
      'apps/a/src/a.test.ts::suite passes',
      'packages/b/src/b.test.ts::standalone passes',
      'packages/b/src/b.test.ts::waits for later',
      'tooling/c/src/c.test.ts::third shard passes',
    ]);
  });

  it('keeps the tests skipped by a platform condition in the report, and still verifies it', () => {
    const merge = {
      ...mergeOf(),
      listSha256: DIGEST,
      skippedUnlisted: ['apps/a/src/a.test.ts::suite runs only on windows'],
    };
    const commands = HOSTED_COMMANDS.map(([id, args]) => ({
      id,
      command: ['pnpm', ...args].join(' '),
      exitCode: 0,
      durationMs: 1,
    }));
    const report = assembleReport({
      candidateSha: SHA,
      runId: RUN,
      runAttempt: '1',
      merge,
      commands,
    });
    expect(report.merge.skippedUnlisted).toEqual([
      'apps/a/src/a.test.ts::suite runs only on windows',
    ]);
    expect(verifyReport(report, EXPECTED).ok).toBe(true);
  });

  it('refuses a report for another candidate SHA', () => {
    const verdict = verifyReport(passingReport(), { ...EXPECTED, candidateSha: 'c'.repeat(40) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(';')).toMatch(/different candidate SHA/u);
  });

  it('refuses a report from another workflow run', () => {
    const verdict = verifyReport(passingReport(), { ...EXPECTED, runId: '1' });
    expect(verdict.reasons.join(';')).toMatch(/different workflow run/u);
  });

  it('refuses a report from a re-run, which can never produce evidence', () => {
    const second = { ...passingReport(), attempt: 2 };
    expect(verifyReport(second, { ...EXPECTED, runAttempt: '2' }).reasons.join(';')).toMatch(
      /first attempt/u,
    );
    expect(verifyReport(passingReport(), { ...EXPECTED, runAttempt: '2' }).ok).toBe(false);
  });

  it('refuses a report whose merge failed, dropped a test, or repeated one', () => {
    for (const name of ['missing', 'duplicated', 'unexpected', 'failed'] as const) {
      const report = passingReport();
      report.merge = { ...report.merge, [name]: ['x'] };
      const verdict = verifyReport(report, EXPECTED);
      expect(verdict.ok, name).toBe(false);
      expect(verdict.reasons.join(';'), name).toMatch(new RegExp(`reports ${name} tests`, 'u'));
    }
  });

  it('refuses a shard set that does not hold exactly three shards with digests', () => {
    const two = passingReport();
    two.shards = two.shards.slice(0, 2);
    expect(verifyReport(two, EXPECTED).reasons.join(';')).toMatch(/exactly 3 Vitest shards/u);
    const undigested = passingReport();
    undigested.shards = undigested.shards.map((shard) => ({ ...shard, sha256: 'short' }));
    expect(verifyReport(undigested, EXPECTED).reasons.join(';')).toMatch(/no digest/u);
  });

  it('refuses a static command that failed, is missing, or is repeated', () => {
    const failed = passingReport();
    failed.commands = failed.commands.map((command) =>
      command.id === 'lint' ? { ...command, exitCode: 1 } : command,
    );
    expect(verifyReport(failed, EXPECTED).reasons.join(';')).toMatch(/lint exited 1/u);

    const missing = passingReport();
    missing.commands = missing.commands.filter((command) => command.id !== 'goldens');
    expect(verifyReport(missing, EXPECTED).reasons.join(';')).toMatch(/goldens is missing/u);

    const repeated = passingReport();
    repeated.commands = [...repeated.commands, repeated.commands[0]];
    expect(verifyReport(repeated, EXPECTED).reasons.join(';')).toMatch(
      /typecheck is missing or repeated/u,
    );
  });

  it('refuses an executed list that does not match the merge count, or holds a failed or unknown test', () => {
    const short = passingReport();
    short.executed = short.executed.slice(1);
    expect(verifyReport(short, EXPECTED).reasons.join(';')).toMatch(
      /executed-test list does not match/u,
    );

    const failedTest = passingReport();
    failedTest.executed = failedTest.executed.map((test, index) =>
      index === 0 ? { ...test, status: 'failed' } : test,
    );
    expect(verifyReport(failedTest, EXPECTED).reasons.join(';')).toMatch(/holds a failed test/u);

    const unknown = passingReport();
    unknown.executed = unknown.executed.map((test, index) =>
      index === 0 ? { ...test, status: 'retried' } : test,
    );
    expect(verifyReport(unknown, EXPECTED).reasons.join(';')).toMatch(/unknown status/u);
  });

  it('refuses a summary that does not match the merge', () => {
    const report = passingReport();
    report.testSummary = { collected: 4, failed: 0 };
    expect(verifyReport(report, EXPECTED).reasons.join(';')).toMatch(
      /test summary does not match/u,
    );
  });

  it('refuses an empty collection, which would otherwise pass with nothing to run', () => {
    const report = passingReport();
    report.list = { count: 0, sha256: DIGEST };
    report.merge = { ...report.merge, listed: 0, executed: 0 };
    report.testSummary = { collected: 0, failed: 0 };
    report.executed = [];
    const verdict = verifyReport(report, EXPECTED);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(';')).toMatch(/collection is empty/u);
  });

  it('refuses a report that is not an object', () => {
    expect(verifyReport(null, EXPECTED).ok).toBe(false);
    expect(verifyReport([], EXPECTED).ok).toBe(false);
  });

  it('yields failing gate inputs when refused, so the gate fails with the reasons on record', () => {
    const verdict = verifyReport({ schemaVersion: 2 }, EXPECTED);
    expect(verdict.ok).toBe(false);
    expect(verdict.testSummary).toEqual({ collected: 0, failed: 1 });
    expect(verdict.commandResults.every((command) => command.exitCode === 1)).toBe(true);
  });

  it('changes its digest when a single byte changes, so the gate detects a swapped report', () => {
    const { bytes, sha256: original } = reportBytes(passingReport());
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 3] ^= 0x01;
    expect(createHash('sha256').update(tampered).digest('hex')).not.toBe(original);
  });
});

describe('static commands', () => {
  it('records each command exit code and runs every command in order', () => {
    const seen: string[] = [];
    const runner = (_command: string, args: string[]) => {
      seen.push(args.join(' '));
      return { status: args[0] === 'lint' ? 3 : 0 };
    };
    const results = runHostedCommands({ root: '/unused', runner: runner as never });
    expect(results.map((command) => command.id)).toEqual(HOSTED_COMMANDS.map(([id]) => id));
    expect(results.find((command) => command.id === 'lint')?.exitCode).toBe(3);
    expect(seen).toHaveLength(HOSTED_COMMANDS.length);
  });

  it('keeps retries off for the goldens command, as the gate policy requires', () => {
    const goldens = HOSTED_COMMANDS.find(([id]) => id === 'goldens');
    expect(goldens?.[1]).toContain('--retry=0');
  });
});

describe('the command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'joy-hosted-verify-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(args: string[]) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  }

  it('merges three shard reports against a collection file and reports the counts', () => {
    const shards = join(dir, 'shards');
    mkdirSync(shards, { recursive: true });
    writeFileSync(join(dir, 'list.json'), JSON.stringify(list));
    writeFileSync(join(shards, 'shard-1.json'), JSON.stringify(shardOne));
    writeFileSync(join(shards, 'shard-2.json'), JSON.stringify(shardTwo));
    writeFileSync(join(shards, 'shard-3.json'), JSON.stringify(shardThree));
    const out = join(dir, 'merge.json');
    const result = run([
      'merge',
      '--list',
      join(dir, 'list.json'),
      '--reports',
      shards,
      '--out',
      out,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const merged = JSON.parse(readFileSync(out, 'utf8'));
    expect(merged).toMatchObject({ ok: true, listed: 5, executed: 5 });
    expect(merged.shards.map((shard: { name: string }) => shard.name)).toEqual([
      'shard-1.json',
      'shard-2.json',
      'shard-3.json',
    ]);
    expect(merged.listSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('refuses a merge with only two shard reports', () => {
    const shards = join(dir, 'two');
    mkdirSync(shards, { recursive: true });
    writeFileSync(join(dir, 'list2.json'), JSON.stringify(list));
    writeFileSync(join(shards, 'shard-1.json'), JSON.stringify(shardOne));
    writeFileSync(join(shards, 'shard-2.json'), JSON.stringify(shardTwo));
    const result = run([
      'merge',
      '--list',
      join(dir, 'list2.json'),
      '--reports',
      shards,
      '--out',
      join(dir, 'never.json'),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Expected 3 shard reports, found 2/u);
  });

  it('assembles a report from the merge and the command results, then verifies it from disk', () => {
    // Reads the merge file the merge test above wrote, so the two tests run in order.
    const merge = join(dir, 'merge.json');
    const commands = join(dir, 'commands.json');
    writeFileSync(
      commands,
      JSON.stringify(
        HOSTED_COMMANDS.map(([id, args]) => ({
          id,
          command: ['pnpm', ...args].join(' '),
          exitCode: 0,
          durationMs: 1,
        })),
      ),
    );
    const common = ['--candidate-sha', SHA, '--run-id', RUN, '--run-attempt', '1'];
    const report = join(dir, 'report.json');
    const assembled = run([
      'assemble',
      '--merge',
      merge,
      '--commands',
      commands,
      ...common,
      '--out',
      report,
    ]);
    expect(assembled.status, assembled.stderr).toBe(0);
    const verified = run(['verify', '--report', report, ...common]);
    expect(verified.status, verified.stderr).toBe(0);
    const wrongRun = run([
      'verify',
      '--report',
      report,
      '--candidate-sha',
      SHA,
      '--run-id',
      '2',
      '--run-attempt',
      '1',
    ]);
    expect(wrongRun.status).toBe(1);
  });
});
