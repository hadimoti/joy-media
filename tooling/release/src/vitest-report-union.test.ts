import { describe, expect, it } from 'vitest';
import { unionReports } from './vitest-report-union.mjs';
import { vitestFromReferenceReport } from './ci-v3-run-inputs.mjs';

// The v2 lanes run on different runners, so the same test can carry a different absolute file name in each lane. The union keeps
// each test once, by its report ID, and a failure in any lane stays a failure.
function lane(file, assertions) {
  return {
    testResults: [
      {
        name: file,
        assertionResults: assertions.map(([title, status]) => ({
          ancestorTitles: ['suite'],
          title,
          fullName: `suite ${title}`,
          status,
        })),
      },
    ],
  };
}

describe('the v2 Vitest report union', () => {
  it('keeps a test that two lanes ran under different absolute paths once', () => {
    const union = unionReports([
      lane('C:/work/repo/apps/cli/src/a.test.ts', [['one', 'passed']]),
      lane('/home/runner/work/joy-media/apps/cli/src/a.test.ts', [
        ['one', 'passed'],
        ['two', 'passed'],
      ]),
    ]);
    expect(union.numTotalTests).toBe(2);
    expect(union.numPassedTests).toBe(2);
    expect(union.numFailedTests).toBe(0);
    expect(union.success).toBe(true);
  });

  it('keeps a failure in any lane a failure', () => {
    const union = unionReports([
      lane('C:/work/repo/apps/cli/src/a.test.ts', [['one', 'passed']]),
      lane('C:/work/repo/apps/cli/src/a.test.ts', [['one', 'failed']]),
    ]);
    expect(union.numFailedTests).toBe(1);
    expect(union.success).toBe(false);
  });

  it('does not let a skip in one lane hide a verdict in another', () => {
    const union = unionReports([
      lane('C:/work/repo/apps/cli/src/a.test.ts', [['one', 'pending']]),
      lane('C:/work/repo/apps/cli/src/a.test.ts', [['one', 'passed']]),
    ]);
    expect(union.numPassedTests).toBe(1);
    expect(union.numPendingTests).toBe(0);
  });

  it('refuses a lane report without test results', () => {
    expect(() => unionReports([{}])).toThrow('lane report 1 has no test results');
  });

  it('hands the executed tests to the two-pass builder, which reads them as the run results', () => {
    const union = unionReports([
      lane('C:/work/repo/apps/cli/src/a.test.ts', [
        ['one', 'passed'],
        ['two', 'pending'],
      ]),
    ]);
    const vitest = vitestFromReferenceReport(union);
    expect(vitest.executed).toEqual(['apps/cli/src/a.test.ts::suite one']);
    expect(vitest.failed).toEqual([]);
  });
});
