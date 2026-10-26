import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countRpcTimeouts,
  failedTestsFromReport,
  repeatUnderLoad,
  summarize,
} from './vitest-load-repeat.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPEAT_WORKFLOW = join(resolve(HERE, '../../..'), '.github', 'workflows', 'ci-repeat.yml');
const yaml = createRequire(join(resolve(HERE, '../../..'), 'package.json'))('js-yaml') as {
  load(source: string): unknown;
};

type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, { 'runs-on': string; steps: Array<Record<string, unknown>> }>;
};

const WORKFLOW_TEXT = readFileSync(REPEAT_WORKFLOW, 'utf8');
const workflow = yaml.load(WORKFLOW_TEXT) as Workflow;

/** The policy the weekly repeat must keep. Returns the first violation, or null. Used on mutated copies too. */
function repeatPolicyViolation(source: string): string | null {
  const parsed = yaml.load(source) as Workflow;
  const triggers = Object.keys(parsed.on).sort();
  if (triggers.join(',') !== 'schedule,workflow_dispatch')
    return `triggers are ${triggers.join(',')}`;
  if (JSON.stringify(parsed.permissions) !== JSON.stringify({ contents: 'read' })) {
    return 'permissions must be exactly contents: read';
  }
  for (const [name, job] of Object.entries(parsed.jobs)) {
    if (!/^ubuntu-24\.04$/u.test(String(job['runs-on'])))
      return `job ${name} is not on a hosted Ubuntu runner`;
  }
  // Only executable content is checked, so a comment that says "never deploys" does not trip the scan.
  const executable = JSON.stringify(parsed.jobs);
  const forbidden =
    /gh\s+release|gh\s+pr\s+merge|gh\s+api|softprops|action-gh-release|deploy|git\s+push|git\s+tag|environment"|secrets\./iu;
  const match = forbidden.exec(executable);
  if (match !== null) return `the workflow names a publishing or deployment step: ${match[0]}`;
  return null;
}

describe('the weekly repeat workflow (D21, not active until merged to main)', () => {
  it('runs only on the weekly schedule and manual dispatch, with read-only permissions', () => {
    expect(repeatPolicyViolation(WORKFLOW_TEXT)).toBeNull();
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(workflow.on.schedule).toEqual([{ cron: '17 4 * * 1' }]);
  });

  it('keeps its one job on a hosted runner, with a receipt that is kept 30 days and uploaded even on failure', () => {
    const job = workflow.jobs['vitest-under-load'];
    expect(job['runs-on']).toBe('ubuntu-24.04');
    const upload = job.steps.find((step) =>
      String(step.uses ?? '').startsWith('actions/upload-artifact@'),
    );
    expect(upload).toBeDefined();
    expect(upload).toMatchObject({
      if: 'always()',
      with: { 'retention-days': 30, 'if-no-files-found': 'error' },
    });
  });

  it('every pass runs Vitest with retries disabled', () => {
    const run = workflow.jobs['vitest-under-load'].steps.find((step) =>
      String(step.run ?? '').includes('vitest-load-repeat.mjs'),
    );
    expect(run).toBeDefined();
    expect(readFileSync(join(HERE, 'vitest-load-repeat.mjs'), 'utf8')).toContain("'--retry=0'");
  });

  it('refuses a mutated copy that publishes, merges, deploys or goes self-hosted (negative controls)', () => {
    const publish = `${WORKFLOW_TEXT}\n      - run: gh release create v9\n`;
    const merge = `${WORKFLOW_TEXT}\n      - run: gh pr merge 12 --auto\n`;
    const pushTrigger = WORKFLOW_TEXT.replace(
      '  workflow_dispatch:\n',
      '  push:\n    branches: [main]\n  workflow_dispatch:\n',
    );
    const selfHosted = WORKFLOW_TEXT.replace(
      'runs-on: ubuntu-24.04\n    timeout-minutes: 180',
      'runs-on: [self-hosted, linux]\n    timeout-minutes: 180',
    );
    const writeToken = WORKFLOW_TEXT.replace(
      'permissions:\n  contents: read',
      'permissions:\n  contents: write',
    );

    expect(repeatPolicyViolation(publish)).toMatch(/publishing or deployment/u);
    expect(repeatPolicyViolation(merge)).toMatch(/publishing or deployment/u);
    expect(repeatPolicyViolation(pushTrigger)).toMatch(/triggers are/u);
    expect(repeatPolicyViolation(selfHosted)).toMatch(/hosted Ubuntu/u);
    expect(repeatPolicyViolation(writeToken)).toMatch(/contents: read/u);
  });
});

describe('the repeat script', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'ci-repeat-'));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('counts "onTaskUpdate" timeouts in console output', () => {
    expect(
      countRpcTimeouts('Timeout calling "onTaskUpdate"\nok\nTimeout calling "onTaskUpdate"'),
    ).toBe(2);
    expect(countRpcTimeouts('no timeouts here')).toBe(0);
  });

  it('names failed tests from a Vitest JSON report, and nothing else', () => {
    const report = {
      testResults: [
        {
          name: '/repo/a.test.ts',
          assertionResults: [
            { fullName: 'adds', status: 'passed' },
            { fullName: 'subtracts', status: 'failed' },
            { fullName: 'skips', status: 'skipped' },
          ],
        },
      ],
    };
    expect(failedTestsFromReport(report)).toEqual(['/repo/a.test.ts::subtracts']);
    expect(failedTestsFromReport(null)).toEqual([]);
  });

  it('derives every receipt count from the passes it records', () => {
    const summary = summarize([
      { pass: 1, exitCode: 0, onTaskUpdateTimeouts: 0, failedTests: [], durationSeconds: 900 },
      {
        pass: 2,
        exitCode: 1,
        onTaskUpdateTimeouts: 2,
        failedTests: ['x::y'],
        durationSeconds: 905,
      },
    ]);
    expect(summary).toMatchObject({
      passes: 2,
      passesWithExitZero: 1,
      passesWithRpcTimeouts: 1,
      rpcTimeoutReports: 2,
      failedTestReports: 1,
    });
  });

  it('keeps the load running for each pass only, stops it even when a pass throws, and writes the receipt', () => {
    const events: string[] = [];
    const writes: Array<{ path: string; text: string }> = [];
    const runPass = (index: number) => {
      events.push(`pass ${index}`);
      if (index === 2) throw new Error('vitest could not start');
      return { exitCode: 0, onTaskUpdateTimeouts: 0, failedTests: [] };
    };

    expect(() =>
      repeatUnderLoad({
        runs: 2,
        out: scratch,
        loadWorkers: 3,
        runPass,
        startLoad: (count: number) => {
          events.push(`load ${count}`);
          return () => events.push('stop');
        },
        writeSummary: (path: string, text: string) => writes.push({ path, text }),
      }),
    ).toThrow(/could not start/u);

    expect(events).toEqual(['load 3', 'pass 1', 'stop', 'load 3', 'pass 2', 'stop']);
    expect(writes).toHaveLength(0);
  });

  it('writes flake-counts.json only from a completed run', () => {
    const writes: Array<{ path: string; text: string }> = [];
    const summary = repeatUnderLoad({
      runs: 2,
      out: scratch,
      loadWorkers: 1,
      runPass: (index: number) => ({
        exitCode: index === 1 ? 0 : 1,
        onTaskUpdateTimeouts: index === 1 ? 0 : 3,
        failedTests: index === 1 ? [] : ['a::b'],
      }),
      startLoad: () => () => undefined,
      writeSummary: (path: string, text: string) => writes.push({ path, text }),
    });

    expect(summary.rpcTimeoutReports).toBe(3);
    expect(writes).toHaveLength(1);
    expect(writes[0].path.endsWith('flake-counts.json')).toBe(true);
    expect(JSON.parse(writes[0].text)).toMatchObject({ passes: 2, passesWithExitZero: 1 });
  });
});
