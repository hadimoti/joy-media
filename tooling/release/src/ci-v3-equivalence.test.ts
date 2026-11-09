import { describe, expect, it } from 'vitest';
import { compareV2WithV3, summarizeVitestJsonReport } from './ci-v3-equivalence.js';

function report(
  files: ReadonlyArray<{
    readonly name: string;
    readonly tests: ReadonlyArray<readonly [string, string]>;
  }>,
): unknown {
  return {
    testResults: files.map((file) => ({
      name: file.name,
      assertionResults: file.tests.map(([fullName, status]) => ({ fullName, status })),
    })),
  };
}

const V2 = report([
  {
    name: 'C:\\work\\joy-media\\packages\\export-core\\src\\index.test.ts',
    tests: [
      ['deterministic export contract keeps 48 kHz audio', 'passed'],
      ['deterministic export contract pads a short capture', 'passed'],
      ['deterministic export contract skips on linux', 'skipped'],
    ],
  },
  {
    name: '/home/runner/work/joy-media/joy-media/apps/api/src/http-server.test.ts',
    tests: [['requires x-joy-frame-count', 'passed']],
  },
]);

describe('summarizing a vitest JSON report', () => {
  it('keeps passed and failed tests as executed, drops skipped tests, and marks failures', () => {
    const summary = summarizeVitestJsonReport(
      report([
        {
          name: '/x/packages/a/src/a.test.ts',
          tests: [
            ['one', 'passed'],
            ['two', 'failed'],
            ['three', 'skipped'],
          ],
        },
      ]),
    );
    expect([...summary.executed].sort()).toEqual([
      'packages/a/src/a.test.ts::one',
      'packages/a/src/a.test.ts::two',
    ]);
    expect([...summary.failed]).toEqual(['packages/a/src/a.test.ts::two']);
  });

  it('makes test IDs repo-relative, so a Windows checkout and a Linux runner compare equal', () => {
    const windows = summarizeVitestJsonReport(V2);
    const linux = summarizeVitestJsonReport(
      report([
        {
          name: '/runner/work/joy-media/joy-media/packages/export-core/src/index.test.ts',
          tests: [
            ['deterministic export contract keeps 48 kHz audio', 'passed'],
            ['deterministic export contract pads a short capture', 'passed'],
          ],
        },
        {
          name: '/runner/work/joy-media/joy-media/apps/api/src/http-server.test.ts',
          tests: [['requires x-joy-frame-count', 'passed']],
        },
      ]),
    );
    expect(compareV2WithV3(windows, linux).missingInV3).toEqual([]);
  });

  it('treats a document without test results as an empty run', () => {
    expect(summarizeVitestJsonReport({}).executed.size).toBe(0);
  });
});

describe('comparing v2 with v3', () => {
  it('accepts a v3 run that executes every v2 test, with the same verdict', () => {
    const v3 = summarizeVitestJsonReport(
      report([
        {
          name: '/x/packages/export-core/src/index.test.ts',
          tests: [
            ['deterministic export contract keeps 48 kHz audio', 'passed'],
            ['deterministic export contract pads a short capture', 'passed'],
            ['a new test only v3 runs', 'passed'],
          ],
        },
        {
          name: '/x/apps/api/src/http-server.test.ts',
          tests: [['requires x-joy-frame-count', 'passed']],
        },
      ]),
    );
    const result = compareV2WithV3(summarizeVitestJsonReport(V2), v3);
    expect(result).toEqual({
      ok: true,
      verdictMatches: true,
      missingInV3: [],
      extraInV3: ['packages/export-core/src/index.test.ts::a new test only v3 runs'],
    });
  });

  it('refuses a v3 run that silently drops a test v2 executed', () => {
    const v3 = summarizeVitestJsonReport(
      report([
        {
          name: '/x/packages/export-core/src/index.test.ts',
          tests: [['deterministic export contract keeps 48 kHz audio', 'passed']],
        },
        {
          name: '/x/apps/api/src/http-server.test.ts',
          tests: [['requires x-joy-frame-count', 'passed']],
        },
      ]),
    );
    const result = compareV2WithV3(summarizeVitestJsonReport(V2), v3);
    expect(result.ok).toBe(false);
    expect(result.missingInV3).toEqual([
      'packages/export-core/src/index.test.ts::deterministic export contract pads a short capture',
    ]);
  });

  it('refuses a v3 run whose verdict differs from v2', () => {
    const v3 = summarizeVitestJsonReport(
      report([
        {
          name: '/x/packages/export-core/src/index.test.ts',
          tests: [
            ['deterministic export contract keeps 48 kHz audio', 'failed'],
            ['deterministic export contract pads a short capture', 'passed'],
          ],
        },
        {
          name: '/x/apps/api/src/http-server.test.ts',
          tests: [['requires x-joy-frame-count', 'passed']],
        },
      ]),
    );
    const result = compareV2WithV3(summarizeVitestJsonReport(V2), v3);
    expect(result.verdictMatches).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('does not count a test that v2 skipped as one v3 must run', () => {
    const v2 = summarizeVitestJsonReport(
      report([{ name: '/x/a.test.ts', tests: [['only skipped in v2', 'skipped']] }]),
    );
    const v3 = summarizeVitestJsonReport(report([]));
    expect(compareV2WithV3(v2, v3).ok).toBe(true);
  });
});
