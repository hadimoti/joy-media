import { describe, expect, it } from 'vitest';
import { executedKeys, listedKeys, mergeShardReports, testKey } from './vitest-shard-merge.mjs';

// Plan section 3.4 (hosted-verify): the three Vitest shards must run every listed test exactly once. These tests build the list and
// the shard reports by hand, the way `vitest list --json` and Vitest's JSON reporter write them, and check each way a merge can fail.
const list = [
  { name: 'suite > passes', file: 'C:/repo/apps/a/src/a.test.ts' },
  { name: 'suite > also passes', file: 'C:/repo/apps/a/src/a.test.ts' },
  { name: 'standalone passes', file: 'C:/repo/packages/b/src/b.test.ts' },
  { name: 'waits for later', file: 'C:/repo/packages/b/src/b.test.ts' },
];

function report(
  file: string,
  results: Array<{ ancestors: string[]; title: string; status: string }>,
) {
  return {
    testResults: [
      {
        name: file,
        assertionResults: results.map((result) => ({
          ancestorTitles: result.ancestors,
          title: result.title,
          status: result.status,
        })),
      },
    ],
  };
}

const shardOne = report('C:\\repo\\apps\\a\\src\\a.test.ts', [
  { ancestors: ['suite'], title: 'passes', status: 'passed' },
  { ancestors: ['suite'], title: 'also passes', status: 'passed' },
]);
const shardTwo = report('C:/repo/packages/b/src/b.test.ts', [
  { ancestors: [], title: 'standalone passes', status: 'passed' },
  { ancestors: [], title: 'waits for later', status: 'passed' },
]);

describe('vitest shard merge', () => {
  it('matches a test by its file and its full name, whatever the path separator', () => {
    expect(testKey('C:\\repo\\a.test.ts', ['suite', 'passes'])).toBe(
      testKey('C:/repo/a.test.ts', ['suite', 'passes']),
    );
    expect(listedKeys([{ name: 'suite > passes', file: 'C:/repo/a.test.ts' }])).toEqual([
      testKey('C:/repo/a.test.ts', ['suite > passes']),
    ]);
    expect(executedKeys(shardOne).map((entry) => entry.key)).toContain(
      testKey('C:/repo/apps/a/src/a.test.ts', ['suite', 'passes']),
    );
  });

  it('passes when the shards together run every listed test exactly once', () => {
    const merged = mergeShardReports(list, [shardOne, shardTwo]);
    expect(merged).toMatchObject({
      ok: true,
      listed: 4,
      executed: 4,
      missing: [],
      duplicated: [],
      unexpected: [],
      failed: [],
    });
  });

  it('refuses a listed test that was skipped at run time, even though every listed test was reported', () => {
    const skippedWaits = report('C:/repo/packages/b/src/b.test.ts', [
      { ancestors: [], title: 'standalone passes', status: 'passed' },
      { ancestors: [], title: 'waits for later', status: 'skipped' },
    ]);
    const merged = mergeShardReports(list, [shardOne, skippedWaits]);
    expect(merged.ok).toBe(false);
    expect(merged.skippedListed).toEqual([
      testKey('C:/repo/packages/b/src/b.test.ts', ['waits for later']),
    ]);
    expect(merged.missing).toEqual([]);
  });

  it('fails when a listed test no shard ran', () => {
    const withoutOne = report('C:/repo/apps/a/src/a.test.ts', [
      { ancestors: ['suite'], title: 'passes', status: 'passed' },
    ]);
    const merged = mergeShardReports(list, [withoutOne, shardTwo]);
    expect(merged.ok).toBe(false);
    expect(merged.missing).toEqual([
      testKey('C:/repo/apps/a/src/a.test.ts', ['suite > also passes']),
    ]);
  });

  it('fails when two shards both ran the same test', () => {
    const merged = mergeShardReports(list, [shardOne, shardTwo, shardOne]);
    expect(merged.ok).toBe(false);
    expect(merged.duplicated.length).toBe(2);
  });

  it('fails when a shard ran a test the list does not name', () => {
    const extra = report('C:/repo/apps/a/src/a.test.ts', [
      { ancestors: ['suite'], title: 'invented', status: 'passed' },
    ]);
    const merged = mergeShardReports(list, [shardOne, shardTwo, extra]);
    expect(merged.ok).toBe(false);
    expect(merged.unexpected).toEqual([
      testKey('C:/repo/apps/a/src/a.test.ts', ['suite > invented']),
    ]);
  });

  it('counts a name that appears twice in one file as two tests, as the list does', () => {
    const twice = [
      { name: 'suite > repeated', file: 'C:/repo/apps/c/src/c.test.ts' },
      { name: 'suite > repeated', file: 'C:/repo/apps/c/src/c.test.ts' },
    ];
    const both = report('C:/repo/apps/c/src/c.test.ts', [
      { ancestors: ['suite'], title: 'repeated', status: 'passed' },
      { ancestors: ['suite'], title: 'repeated', status: 'passed' },
    ]);
    expect(mergeShardReports(twice, [both])).toMatchObject({
      ok: true,
      listed: 2,
      executed: 2,
      missing: [],
      duplicated: [],
    });
    const once = report('C:/repo/apps/c/src/c.test.ts', [
      { ancestors: ['suite'], title: 'repeated', status: 'passed' },
    ]);
    expect(mergeShardReports(twice, [once]).missing).toEqual([
      testKey('C:/repo/apps/c/src/c.test.ts', ['suite > repeated']),
    ]);
    const thrice = report('C:/repo/apps/c/src/c.test.ts', [
      { ancestors: ['suite'], title: 'repeated', status: 'passed' },
      { ancestors: ['suite'], title: 'repeated', status: 'passed' },
      { ancestors: ['suite'], title: 'repeated', status: 'passed' },
    ]);
    expect(mergeShardReports(twice, [thrice]).duplicated).toEqual([
      testKey('C:/repo/apps/c/src/c.test.ts', ['suite > repeated']),
    ]);
  });

  it('fails when a shard reports a failed test, even though every test ran', () => {
    const failing = report('C:/repo/packages/b/src/b.test.ts', [
      { ancestors: [], title: 'standalone passes', status: 'failed' },
      { ancestors: [], title: 'waits for later', status: 'skipped' },
    ]);
    const merged = mergeShardReports(list, [shardOne, failing]);
    expect(merged.ok).toBe(false);
    expect(merged.failed).toEqual([
      testKey('C:/repo/packages/b/src/b.test.ts', ['standalone passes']),
    ]);
    expect(merged.missing).toEqual([]);
  });
});
