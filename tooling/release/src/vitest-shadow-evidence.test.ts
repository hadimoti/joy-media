import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHECKSUM_FILE,
  REQUIRED_INSTANCES,
  artifactName,
  unionShadowEvidence,
  verifyShadowEvidence,
} from './vitest-shadow-evidence.mjs';

const RUN = {
  runId: '40401999522',
  attempt: '1',
  candidateSha: 'f71e899d7054eb035e372d8d351960e45148ba16',
};

type Instance = (typeof REQUIRED_INSTANCES)[number];
type Test = { file: string; title: string; status?: 'passed' | 'pending' };

// The required instance whose base name ends with the given suffix, such as `node-24` or `pass-2`.
function instance(suffix: string): Instance {
  const found = REQUIRED_INSTANCES.find((candidate: Instance) => candidate.base.endsWith(suffix));
  if (found === undefined) throw new Error(`no required instance ends with ${suffix}`);
  return found;
}

// A Vitest JSON report of the given tests, counted the way Vitest counts them.
function vitestReport(tests: Test[]) {
  const files = new Map<string, unknown[]>();
  for (const test of tests) {
    const assertions = files.get(test.file) ?? [];
    assertions.push({
      ancestorTitles: ['suite'],
      title: test.title,
      fullName: `suite ${test.title}`,
      status: test.status ?? 'passed',
    });
    files.set(test.file, assertions);
  }
  const count = (status: string) =>
    tests.filter((test) => (test.status ?? 'passed') === status).length;
  return {
    numTotalTests: tests.length,
    numPassedTests: count('passed'),
    numFailedTests: 0,
    numPendingTests: count('pending'),
    numTodoTests: 0,
    success: true,
    testResults: [...files].map(([name, assertionResults]) => ({
      name,
      status: 'passed',
      assertionResults,
    })),
  };
}

// The reports each required instance writes, with a few tests in each. Node 22 and Node 24 run the same tests, as do the Linux
// passes, and the paths differ between runners, as they do in CI.
const REPORTS: Record<string, Record<string, unknown>> = {
  'node-contracts-node-22.17.0': {
    'node-contracts-cli.json': vitestReport([
      { file: 'C:/work/apps/cli/src/a.test.ts', title: 'one' },
      { file: 'C:/work/apps/cli/src/a.test.ts', title: 'two', status: 'pending' },
    ]),
    'node-contracts-pg.json': vitestReport([
      { file: 'C:/work/apps/api/src/usdc.pg.test.ts', title: 'ledger' },
    ]),
  },
  'node-contracts-node-24': {
    'node-contracts-cli.json': vitestReport([
      { file: '/home/runner/apps/cli/src/a.test.ts', title: 'one' },
      { file: '/home/runner/apps/cli/src/a.test.ts', title: 'two', status: 'pending' },
    ]),
    'node-contracts-pg.json': vitestReport([
      { file: '/home/runner/apps/api/src/usdc.pg.test.ts', title: 'ledger' },
    ]),
  },
  'linux-p0-pass-1': {
    'linux-p0.json': vitestReport([
      { file: 'C:/work/apps/desktop/src/p0.test.ts', title: 'render' },
    ]),
  },
  'linux-p0-pass-2': {
    'linux-p0.json': vitestReport([
      { file: '/home/runner/apps/desktop/src/p0.test.ts', title: 'render' },
    ]),
  },
  'windows-p0': {
    'windows-p0.json': vitestReport([
      { file: 'C:/work/apps/desktop/src/p0.test.ts', title: 'render' },
    ]),
    'windows-cli.json': vitestReport([{ file: 'C:/work/apps/cli/src/a.test.ts', title: 'one' }]),
  },
};

function instanceKey(item: Instance): string {
  return item.base.replace('joy-media-v2-vitest-', '');
}

// Writes one instance's artifact the way a lane does: each report, then the checksum file that lists them.
function writeArtifact(
  root: string,
  item: Instance,
  files: Record<string, string>,
  withChecksums = true,
): string {
  const dir = join(root, artifactName(item, RUN));
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text, 'utf8');
    lines.push(`${createHash('sha256').update(text).digest('hex')}  ${name}`);
  }
  if (withChecksums) writeFileSync(join(dir, CHECKSUM_FILE), `${lines.join('\n')}\n`, 'utf8');
  return dir;
}

function jsonFiles(reports: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(reports).map(([name, body]) => [name, `${JSON.stringify(body, null, 2)}\n`]),
  );
}

function writeCompleteRun(root: string) {
  for (const item of REQUIRED_INSTANCES) {
    writeArtifact(root, item, jsonFiles(REPORTS[instanceKey(item)]));
  }
}

describe('the v2 shadow Vitest evidence', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shadow-evidence-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts a run in which every required matrix instance has a complete, checked report', () => {
    writeCompleteRun(root);
    const verdict = verifyShadowEvidence({ root, ...RUN });
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.instances).toHaveLength(REQUIRED_INSTANCES.length);
  });

  it('names each matrix instance differently, so no two instances share an artifact', () => {
    const names = REQUIRED_INSTANCES.map((item: Instance) => artifactName(item, RUN));
    expect(new Set(names).size).toBe(REQUIRED_INSTANCES.length);
    expect(names).toContain(
      `joy-media-v2-vitest-node-contracts-node-24-40401999522-1-${RUN.candidateSha}`,
    );
    expect(names).toContain(
      `joy-media-v2-vitest-linux-p0-pass-2-40401999522-1-${RUN.candidateSha}`,
    );
  });

  it('refuses a run whose Node 24 instance has no artifact', () => {
    writeCompleteRun(root);
    const node24 = instance('node-24');
    rmSync(join(root, artifactName(node24, RUN)), { recursive: true, force: true });
    const verdict = verifyShadowEvidence({ root, ...RUN });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual([`${artifactName(node24, RUN)}: the artifact is missing`]);
  });

  it('refuses a report that does not match its recorded checksum', () => {
    writeCompleteRun(root);
    const pass2 = instance('pass-2');
    writeFileSync(
      join(root, artifactName(pass2, RUN), 'linux-p0.json'),
      '{"numTotalTests":1}\n',
      'utf8',
    );
    const verdict = verifyShadowEvidence({ root, ...RUN });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual([
      `${artifactName(pass2, RUN)}: linux-p0.json does not match its recorded checksum`,
    ]);
  });

  it('refuses an artifact whose checksum file is missing', () => {
    writeCompleteRun(root);
    const windows = instance('windows-p0');
    rmSync(join(root, artifactName(windows, RUN), CHECKSUM_FILE));
    const verdict = verifyShadowEvidence({ root, ...RUN });
    expect(verdict.problems).toEqual([
      `${artifactName(windows, RUN)}: ${CHECKSUM_FILE} is missing`,
    ]);
  });

  it('refuses a report that is not listed in its checksum file', () => {
    const node22 = instance('node-22.17.0');
    const files = jsonFiles(REPORTS[instanceKey(node22)]);
    const dir = writeArtifact(root, node22, files, false);
    const cliText = files['node-contracts-cli.json'];
    writeFileSync(
      join(dir, CHECKSUM_FILE),
      `${createHash('sha256').update(cliText).digest('hex')}  node-contracts-cli.json\n`,
      'utf8',
    );
    const verdict = verifyShadowEvidence({ root, ...RUN });
    expect(verdict.problems).toContain(
      `${artifactName(node22, RUN)}: node-contracts-pg.json has no recorded checksum`,
    );
  });

  it('accepts checksum lines in both sha256sum forms, text mode and binary mode', () => {
    writeCompleteRun(root);
    const pass1 = instance('pass-1');
    const dir = join(root, artifactName(pass1, RUN));
    const text = jsonFiles(REPORTS['linux-p0-pass-1'])['linux-p0.json'];
    // Binary mode, as Git Bash writes it: the name follows a space and an asterisk.
    writeFileSync(
      join(dir, CHECKSUM_FILE),
      `${createHash('sha256').update(text).digest('hex')} *linux-p0.json\n`,
      'utf8',
    );
    const verdict = verifyShadowEvidence({ root, ...RUN });
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('refuses a report that is not readable JSON, even when its checksum matches', () => {
    writeCompleteRun(root);
    const windows = instance('windows-p0');
    writeArtifact(root, windows, {
      'windows-p0.json': '{"numTotalTests": 1,',
      'windows-cli.json': jsonFiles(REPORTS['windows-p0'])['windows-cli.json'],
    });
    const verdict = verifyShadowEvidence({ root, ...RUN });
    expect(verdict.problems).toHaveLength(1);
    expect(verdict.problems[0]).toMatch(
      new RegExp(`^${artifactName(windows, RUN)}: windows-p0\\.json is unreadable JSON \\(`, 'u'),
    );
  });

  it('refuses a partial report: a declared test that is not counted, or a count that does not add up', () => {
    const node24 = instance('node-24');
    const truncated = vitestReport([
      { file: 'x.test.ts', title: 'a' },
      { file: 'x.test.ts', title: 'b' },
    ]);
    truncated.numTotalTests = 1;
    truncated.numPassedTests = 1;
    writeArtifact(root, node24, {
      'node-contracts-cli.json': `${JSON.stringify(truncated)}\n`,
      'node-contracts-pg.json': `${JSON.stringify(vitestReport([{ file: 'y.test.ts', title: 'c' }]))}\n`,
    });
    const verdict = verifyShadowEvidence({ root, ...RUN });
    expect(verdict.problems).toContain(
      `${artifactName(node24, RUN)}: node-contracts-cli.json declares 2 tests but counts 1`,
    );
  });

  it('refuses an artifact that carries a report which no matrix instance writes', () => {
    writeCompleteRun(root);
    const pass1 = instance('pass-1');
    writeFileSync(join(root, artifactName(pass1, RUN), 'stray.json'), '{}\n', 'utf8');
    const verdict = verifyShadowEvidence({ root, ...RUN });
    expect(verdict.problems).toEqual([`${artifactName(pass1, RUN)}: unexpected file stray.json`]);
  });

  it('merges the verified reports into one union that keeps each test once', () => {
    writeCompleteRun(root);
    const result = unionShadowEvidence({ root, ...RUN });
    expect(result.ok).toBe(true);
    // Four distinct tests: two CLI tests (one passes, one is pending), the PG ledger test and the P0 render test. Every lane that ran
    // them reports them, and the union keeps each once.
    expect(result.union?.numTotalTests).toBe(4);
    expect(result.union?.numPassedTests).toBe(3);
    expect(result.union?.numPendingTests).toBe(1);
    expect(result.union?.numFailedTests).toBe(0);
  });

  it('does not produce a union from an incomplete run', () => {
    writeCompleteRun(root);
    const pass1 = instance('pass-1');
    rmSync(join(root, artifactName(pass1, RUN)), { recursive: true, force: true });
    const result = unionShadowEvidence({ root, ...RUN });
    expect(result.ok).toBe(false);
    expect(result.union).toBeUndefined();
  });
});
