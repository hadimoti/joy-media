import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ATTENDED_RECEIPT_ROOT,
  evaluateReleaseGate,
  readAttendedEvidence,
  resolveAttendedCandidate,
  type ReleaseGateInput,
} from './gate.ts';

const git = process.platform === 'win32' ? 'git.exe' : 'git';

let root = '';
const shas: Record<string, string> = {};

function run(...args: string[]): string {
  const result = spawnSync(git, args, { cwd: root, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(name: string, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  run('add', '-A');
  run('commit', '-q', '-m', name);
  return run('rev-parse', 'HEAD');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'joy-candidate-'));
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'Test');
  run('config', 'commit.gpgsign', 'false');
  shas.candidate = commit('candidate', { 'src/app.txt': 'one' });
  shas.receipts = commit('receipts only', {
    [`${ATTENDED_RECEIPT_ROOT}${shas.candidate}/sandbox-lifecycle.json`]: '{}',
  });
  shas.tooling = commit('release tooling only', { 'tooling/release/src/gate.txt': 'x' });
  shas.code = commit('code change', { 'src/app.txt': 'two' });
  run('checkout', '-q', '-b', 'other', shas.candidate);
  shas.other = commit('other branch', { 'src/other.txt': 'x' });
  run('checkout', '-q', 'main');
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('resolveAttendedCandidate', () => {
  it('uses HEAD when no candidate is named, or when the candidate is HEAD', () => {
    expect(resolveAttendedCandidate(root, shas.code!, undefined)).toEqual({
      candidateSha: shas.code,
      problems: [],
    });
    expect(resolveAttendedCandidate(root, shas.code!, shas.code!.toUpperCase())).toEqual({
      candidateSha: shas.code,
      problems: [],
    });
  });

  it('accepts a candidate followed only by commits that add receipts', () => {
    expect(resolveAttendedCandidate(root, shas.receipts!, shas.candidate)).toEqual({
      candidateSha: shas.candidate,
      problems: [],
    });
  });

  it('accepts a candidate followed by receipts and release tooling changes', () => {
    expect(resolveAttendedCandidate(root, shas.tooling!, shas.candidate)).toEqual({
      candidateSha: shas.candidate,
      problems: [],
    });
  });

  it('refuses a candidate followed by a change outside the receipt folder and the release tooling', () => {
    const result = resolveAttendedCandidate(root, shas.code!, shas.candidate);
    expect(result.candidateSha).toBe(shas.candidate);
    expect(result.problems.join(';')).toMatch(/outside docs\/release\/attended\/.*src\/app\.txt/u);
  });

  it('refuses a candidate that is not an ancestor, not a full SHA, or not in the clone', () => {
    expect(resolveAttendedCandidate(root, shas.code!, shas.other).problems.join(';')).toMatch(
      /not an ancestor/u,
    );
    expect(resolveAttendedCandidate(root, shas.code!, 'abc123').problems.join(';')).toMatch(
      /full commit SHA/u,
    );
    expect(resolveAttendedCandidate(root, shas.code!, 'f'.repeat(40)).problems.join(';')).toMatch(
      /does not exist/u,
    );
  });
});

describe('binding problems reach the local-only checks', () => {
  const base: ReleaseGateInput = {
    testSummary: { collected: 1, failed: 0 },
    dirtyGeneratedArtifacts: [],
    fixtureHandlers: [],
    deploymentManifests: [],
    builds: { editor: true, worker: true },
    staticAssetPackaging: [],
    manifestGenerated: true,
    sbomGenerated: true,
    browserJourneys: [],
    featureStatus: { auditedOn: new Date().toISOString().slice(0, 10), statuses: ['production'] },
    profile: 'local-only',
  };

  it('fails both checks and names the reason', () => {
    const evidence = readAttendedEvidence(root, shas.candidate!, [
      'commits after the candidate change code',
    ]);
    expect(evidence?.bindingProblems).toEqual(['commits after the candidate change code']);
    const result = evaluateReleaseGate({ ...base, attendedEvidence: evidence }, new Date());
    for (const id of ['attended-journey', 'lifecycle-evidence']) {
      const item = result.checks.find((entry) => entry.id === id);
      expect(item?.status).toBe('failed');
      expect(item?.message).toContain('commits after the candidate change code');
    }
  });
});
