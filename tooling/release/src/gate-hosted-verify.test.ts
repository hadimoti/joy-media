// The final gate's reader for the hosted-verify report (plan section 3.4, release-candidate-v3). The gate takes its static results
// from the report only when the report is complete, bound to this candidate, run and attempt, and has the digest its job
// produced. Each refusal below leaves the gate with failing inputs, so the release gate fails with the reason on record.
// The two-pass gate names no report, and its path is unchanged: hostedVerifyFromEnvironment returns null when none is named.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleReport, HOSTED_COMMANDS } from './hosted-verify.mjs';
import { hostedVerifyFromEnvironment } from './gate.ts';

const SHA = 'a'.repeat(40);
const RUN = '40400000001';
const DIGEST = 'b'.repeat(64);
const REPORT = 'test-output/hosted-verify/report.json';

function completeReport(): Record<string, unknown> {
  const tests = [
    { id: 'apps/a/src/a.test.ts::suite passes', status: 'passed' },
    { id: 'apps/a/src/a.test.ts::suite also passes', status: 'passed' },
    { id: 'packages/b/src/b.test.ts::standalone', status: 'passed' },
  ];
  const merge = {
    ok: true,
    listed: 3,
    executed: 3,
    missing: [],
    duplicated: [],
    unexpected: [],
    skippedListed: [],
    failed: [],
    shards: [1, 2, 3].map((n) => ({ name: `shard-${n}.json`, sha256: DIGEST, tests: 1 })),
    listSha256: DIGEST,
    executedTests: tests,
  };
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
  }) as unknown as Record<string, unknown>;
}

let root: string;

/** Writes the report at the path the gate reads, and sets the environment the gate receives from its workflow. */
function arrange(
  report: unknown,
  overrides: { digest?: string; sha?: string; runAttempt?: string } = {},
) {
  const bytes = Buffer.from(
    typeof report === 'string' ? report : `${JSON.stringify(report, null, 2)}\n`,
  );
  mkdirSync(join(root, 'test-output/hosted-verify'), { recursive: true });
  writeFileSync(join(root, REPORT), bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  vi.stubEnv('JOY_RELEASE_HOSTED_VERIFY_REPORT', REPORT);
  vi.stubEnv('JOY_RELEASE_HOSTED_VERIFY_SHA256', overrides.digest ?? digest);
  vi.stubEnv('JOY_RELEASE_CANDIDATE_SHA', overrides.sha ?? SHA);
  vi.stubEnv('JOY_RELEASE_WORKFLOW_RUN_ID', RUN);
  vi.stubEnv('JOY_RELEASE_WORKFLOW_RUN_ATTEMPT', overrides.runAttempt ?? '1');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'joy-gate-hosted-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('the gate reads the hosted-verify report', () => {
  it('names no report for the two-pass gate, so it runs its own commands as before', () => {
    vi.stubEnv('JOY_RELEASE_HOSTED_VERIFY_REPORT', '');
    expect(hostedVerifyFromEnvironment(root)).toBeNull();
  });

  it('accepts a complete report bound to this candidate, run and attempt, with the digest its job produced', () => {
    arrange(completeReport());
    const outcome = hostedVerifyFromEnvironment(root);
    expect(outcome?.reasons).toEqual([]);
    expect(outcome?.testSummary).toEqual({ collected: 3, failed: 0 });
    expect(outcome?.commandResults.map((command) => command.id)).toEqual([
      'typecheck',
      'lint',
      'format',
      'goldens',
      'tests',
    ]);
    expect(outcome?.commandResults.every((command) => command.exitCode === 0)).toBe(true);
    expect(outcome?.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('refuses a report whose digest is not the one its job output, so a swapped file fails', () => {
    arrange(completeReport(), { digest: 'c'.repeat(64) });
    const outcome = hostedVerifyFromEnvironment(root);
    expect(outcome?.reasons.join(';')).toMatch(/does not match the digest its job produced/u);
    expect(outcome?.testSummary).toEqual({ collected: 0, failed: 1 });
    expect(outcome?.commandResults.find((command) => command.id === 'tests')?.exitCode).toBe(1);
  });

  it('refuses a report when its job supplied no digest at all', () => {
    arrange(completeReport(), { digest: '' });
    expect(hostedVerifyFromEnvironment(root)?.reasons.join(';')).toMatch(
      /digest was not supplied/u,
    );
  });

  it('refuses a report that is missing from the workspace', () => {
    vi.stubEnv('JOY_RELEASE_HOSTED_VERIFY_REPORT', REPORT);
    vi.stubEnv('JOY_RELEASE_HOSTED_VERIFY_SHA256', DIGEST);
    expect(hostedVerifyFromEnvironment(root)?.reasons.join(';')).toMatch(/report is missing/u);
  });

  it('refuses a report that is not valid JSON', () => {
    arrange('{ not json');
    expect(hostedVerifyFromEnvironment(root)?.reasons.join(';')).toMatch(/not valid JSON/u);
  });

  it('refuses a report for another candidate SHA', () => {
    arrange(completeReport(), { sha: 'c'.repeat(40) });
    expect(hostedVerifyFromEnvironment(root)?.reasons.join(';')).toMatch(
      /different candidate SHA/u,
    );
  });

  it('refuses a report from a re-run of the workflow', () => {
    arrange(completeReport(), { runAttempt: '2' });
    expect(hostedVerifyFromEnvironment(root)?.reasons.join(';')).toMatch(/first attempt/u);
  });

  it('refuses a report whose shards did not cover every test, even with a matching digest', () => {
    const report = completeReport() as { merge: Record<string, unknown> };
    report.merge = { ...report.merge, ok: false, missing: ['x'] };
    arrange(report);
    const outcome = hostedVerifyFromEnvironment(root);
    expect(outcome?.reasons.join(';')).toMatch(/reports missing tests/u);
    expect(outcome?.testSummary.failed).toBe(1);
  });
});
