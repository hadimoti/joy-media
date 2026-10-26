// The merge's rule for tests Vitest skips by a platform condition (`it.skipIf(process.platform === ...)`). `vitest list` names no
// such test, but the JSON report records it as skipped. The merge must not count it as executed, and must not fail on it. It
// must still fail on a test that ran but is not listed, and on a listed test that no shard reports.
import { describe, expect, it } from 'vitest';
import { mergeShardReports } from './vitest-shard-merge.mjs';
import { mergeShards } from './hosted-verify.mjs';

const FILE = 'C:/repo/apps/a/src/a.test.ts';
const list = [
  { name: 'suite > runs everywhere', file: FILE },
  { name: 'suite > windows only', file: FILE },
];

function report(rows: Array<[string, string]>) {
  return {
    testResults: [
      {
        name: FILE,
        assertionResults: rows.map(([title, status]) => ({
          ancestorTitles: ['suite'],
          title,
          fullName: `suite ${title}`,
          status,
        })),
      },
    ],
  };
}

describe('tests skipped by a platform condition', () => {
  it('does not fail the merge for a skipped test the collection does not list', () => {
    const shard = report([
      ['runs everywhere', 'passed'],
      ['windows only', 'skipped'],
    ]);
    const unlisted = report([['linux only', 'skipped']]);
    const merged = mergeShardReports(
      [{ name: 'suite > runs everywhere', file: FILE }],
      [shard, unlisted],
    );
    expect(merged.ok).toBe(true);
    expect(merged.unexpected).toEqual([]);
  });

  it('records the unlisted skip, and keeps it out of the executed list', () => {
    const shards = [
      report([
        ['runs everywhere', 'passed'],
        ['windows only', 'skipped'],
      ]),
      { testResults: [{ name: FILE, assertionResults: [] }] },
    ];
    const merged = mergeShards({
      list: [{ name: 'suite > runs everywhere', file: FILE }],
      reports: shards,
      shards: shards.map((_, index) => ({
        name: `shard-${index + 1}.json`,
        sha256: 'b'.repeat(64),
        tests: 1,
      })),
    });
    expect(merged.ok).toBe(true);
    expect(merged.executedTests.map((test) => test.id)).toEqual([
      'apps/a/src/a.test.ts::suite runs everywhere',
    ]);
    expect(merged.skippedUnlisted).toEqual(['apps/a/src/a.test.ts::suite windows only']);
  });

  it('still fails when a test the collection does not list actually ran', () => {
    const ran = report([
      ['runs everywhere', 'passed'],
      ['windows only', 'passed'],
    ]);
    const merged = mergeShardReports([{ name: 'suite > runs everywhere', file: FILE }], [ran]);
    expect(merged.ok).toBe(false);
    expect(merged.unexpected).toEqual([
      `${FILE} :: suite > windows only`.replace(' :: ', '\u0000'),
    ]);
  });

  it('still fails when a listed test no shard reports, even if another shard skipped its neighbour', () => {
    const merged = mergeShardReports(list, [report([['runs everywhere', 'skipped']])]);
    expect(merged.ok).toBe(false);
    expect(merged.missing).toEqual([`${FILE}\u0000suite > windows only`]);
  });
});
