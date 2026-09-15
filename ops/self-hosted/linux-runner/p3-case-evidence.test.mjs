/* global process */
/* P3 per-case evidence aggregate unit tests.
 *
 * Runs with the p3 vitest config:
 *   pnpm exec vitest run --config ops/self-hosted/linux-runner/vitest.p3.config.ts
 *
 * Tests are synthetic: they validate the data shape, provenance copy,
 * NOT RUN -> started -> PASS/FAIL transitions, persistence atomicity,
 * and that the aggregate cannot drift from the 20-row matrix registry.
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  P3_CASE_EVIDENCE_PATH,
  P3_CASE_EVIDENCE_SCHEMA_VERSION,
  P3_CASE_EVIDENCE_TMP_SUFFIX,
  newP3CaseEvidence,
  persistP3CaseEvidence,
  setCaseFinished,
  setCaseStarted,
  validateP3CaseEvidenceForSuccess,
  validateP3CaseEvidenceShape,
} from './p3-case-evidence.mjs';
import { P3_CASE_REGISTRY, p3Provenance } from './p3-case-registry.mjs';

const VALID_PROVENANCE = p3Provenance({
  candidateSha: '0c70c61cdfc692e04a7c46d3b37a6e94a1d7adfe',
  runId: '34540790794',
  runAttempt: '1',
  pass: '1',
  issuedAt: '2026-09-11T01:00:00.000Z',
});

const FIRST_CASE_ID = P3_CASE_REGISTRY.rows[0].caseId;
const SECOND_CASE_ID = P3_CASE_REGISTRY.rows[1].caseId;

describe('p3-case-evidence aggregate', () => {
  let workdir;
  let originalCwd;

  beforeEach(async () => {
    originalCwd = process.cwd();
    workdir = await mkWorkdir();
    process.chdir(workdir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (workdir !== undefined) await rm(workdir, { recursive: true, force: true });
  });

  it('starts in NOT RUN with exactly 20 rows mirroring the registry order', () => {
    const aggregate = newP3CaseEvidence(VALID_PROVENANCE);
    expect(aggregate.schemaVersion).toBe(P3_CASE_EVIDENCE_SCHEMA_VERSION);
    expect(aggregate.cases).toHaveLength(20);
    expect(aggregate.cases.map((row) => row.caseId)).toEqual(
      P3_CASE_REGISTRY.rows.map((row) => row.caseId),
    );
    for (const [index, row] of aggregate.cases.entries()) {
      expect(row.pack).toBe(P3_CASE_REGISTRY.rows[index].pack);
      expect(row.preset).toBe(P3_CASE_REGISTRY.rows[index].preset);
      expect(row.kind).toBe(P3_CASE_REGISTRY.rows[index].kind);
      expect(row.phase).toBe('NOT RUN');
      expect(row.result).toBe('NOT RUN');
      expect(row.reason).toBeNull();
      expect(row.error).toBeNull();
      expect(row.evidence).toBeNull();
    }
    validateP3CaseEvidenceShape(aggregate);
  });

  it('copies provenance by value, not by reference (caller mutation does not poison the aggregate)', () => {
    const provenance = { ...VALID_PROVENANCE };
    const aggregate = newP3CaseEvidence(provenance);
    provenance.runId = 'mutated-after-init';
    expect(aggregate.provenance.runId).toBe(VALID_PROVENANCE.runId);
  });

  it('records started then finished transitions for one case without disturbing the other 19', () => {
    const initial = newP3CaseEvidence(VALID_PROVENANCE);
    let aggregate = initial;
    aggregate = setCaseStarted(aggregate, FIRST_CASE_ID, 'arming observer');
    expect(aggregate.cases[0].phase).toBe('started');
    expect(aggregate.cases[0].reason).toBe('arming observer');
    expect(aggregate.cases[0].result).toBe('NOT RUN');
    aggregate = setCaseFinished(aggregate, FIRST_CASE_ID, 'PASS', { foo: 'bar' }, null);
    expect(aggregate.cases[0].phase).toBe('PASS');
    expect(aggregate.cases[0].result).toBe('PASS');
    expect(aggregate.cases[0].error).toBeNull();
    expect(aggregate.cases[0].evidence).toEqual({ foo: 'bar' });
    // The rest is untouched.
    for (let index = 1; index < aggregate.cases.length; index += 1) {
      expect(aggregate.cases[index].phase).toBe('NOT RUN');
      expect(aggregate.cases[index].evidence).toBeNull();
    }
    // Original aggregate is unchanged (immutability contract).
    expect(initial.cases).not.toBe(aggregate.cases);
    expect(initial.cases[0].phase).toBe('NOT RUN');
    validateP3CaseEvidenceShape(aggregate);
  });

  it('preserves an interrupted-started case as phase=started, result=NOT RUN until finally fires', () => {
    let aggregate = newP3CaseEvidence(VALID_PROVENANCE);
    aggregate = setCaseStarted(aggregate, FIRST_CASE_ID, 'arming cancel observer');
    // simulate process killed: no setCaseFinished call.
    validateP3CaseEvidenceShape(aggregate);
    expect(aggregate.cases[0].phase).toBe('started');
    expect(aggregate.cases[0].result).toBe('NOT RUN');
    expect(aggregate.cases[0].reason).toBe('arming cancel observer');
  });

  it('records a FAIL with the captured error message and preserves any partial evidence', () => {
    let aggregate = newP3CaseEvidence(VALID_PROVENANCE);
    aggregate = setCaseStarted(aggregate, FIRST_CASE_ID);
    const partialEvidence = { projectBefore: { projectId: 'p1' } };
    aggregate = setCaseFinished(
      aggregate,
      FIRST_CASE_ID,
      'FAIL',
      partialEvidence,
      'Export MP4 click failed: timeout',
    );
    expect(aggregate.cases[0].phase).toBe('FAIL');
    expect(aggregate.cases[0].result).toBe('FAIL');
    expect(aggregate.cases[0].reason).toBe('Export MP4 click failed: timeout');
    expect(aggregate.cases[0].error).toBe('Export MP4 click failed: timeout');
    expect(aggregate.cases[0].evidence).toEqual(partialEvidence);
    validateP3CaseEvidenceShape(aggregate);
  });

  it('refuses an unknown caseId for both transitions', () => {
    const aggregate = newP3CaseEvidence(VALID_PROVENANCE);
    expect(() => setCaseStarted(aggregate, 'not-a-real-case')).toThrow(/unknown caseId/);
    expect(() => setCaseFinished(aggregate, 'not-a-real-case', 'PASS', null)).toThrow(
      /unknown caseId/,
    );
  });

  it('rejects an invalid terminal result string', () => {
    const aggregate = newP3CaseEvidence(VALID_PROVENANCE);
    expect(() => setCaseFinished(aggregate, FIRST_CASE_ID, 'NOT RUN', null)).toThrow(
      /invalid result/,
    );
  });

  it('persists atomically — a successful write replaces the file and removes the tmp', async () => {
    let aggregate = newP3CaseEvidence(VALID_PROVENANCE);
    aggregate = setCaseStarted(aggregate, FIRST_CASE_ID, 'arming observer');
    aggregate = setCaseFinished(
      aggregate,
      FIRST_CASE_ID,
      'PASS',
      { projectBefore: { projectId: 'p1' }, syncEvents: [{ fraction: 0.1, driftSeconds: 0.012 }] },
      null,
    );
    aggregate = setCaseStarted(aggregate, SECOND_CASE_ID, 'arming cancel observer');
    await mkdir('test-output/browser', { recursive: true });
    await persistP3CaseEvidence(aggregate);
    expect(existsSync(P3_CASE_EVIDENCE_PATH)).toBe(true);
    const raw = await readFile(P3_CASE_EVIDENCE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    validateP3CaseEvidenceShape(parsed);
    expect(parsed.cases[0].result).toBe('PASS');
    expect(parsed.cases[0].evidence).toEqual({
      projectBefore: { projectId: 'p1' },
      syncEvents: [{ fraction: 0.1, driftSeconds: 0.012 }],
    });
    expect(parsed.cases[1].phase).toBe('started');
    // No stale tmp file remains.
    expect(existsSync(`${P3_CASE_EVIDENCE_PATH}.tmp`)).toBe(false);
  });

  it('persists a partial-state aggregate truthfully (interrupted run)', async () => {
    let aggregate = newP3CaseEvidence(VALID_PROVENANCE);
    aggregate = setCaseStarted(aggregate, FIRST_CASE_ID, 'arming observer');
    // Simulate interruption — no setCaseFinished call.
    await mkdir('test-output/browser', { recursive: true });
    await persistP3CaseEvidence(aggregate);
    const raw = JSON.parse(await readFile(P3_CASE_EVIDENCE_PATH, 'utf8'));
    validateP3CaseEvidenceShape(raw);
    expect(raw.cases[0].phase).toBe('started');
    expect(raw.cases[0].result).toBe('NOT RUN');
    expect(raw.cases[0].reason).toBe('arming observer');
  });

  it('subsequent persists over-write the previous file (not append)', async () => {
    let aggregate = newP3CaseEvidence(VALID_PROVENANCE);
    aggregate = setCaseFinished(aggregate, FIRST_CASE_ID, 'PASS', { a: 1 }, null);
    await mkdir('test-output/browser', { recursive: true });
    await persistP3CaseEvidence(aggregate);
    const firstRaw = await readFile(P3_CASE_EVIDENCE_PATH, 'utf8');
    expect(firstRaw).toContain('"a": 1');

    // A second persist for the same case updates evidence without doubling the file.
    aggregate = setCaseFinished(aggregate, FIRST_CASE_ID, 'PASS', { a: 2, b: 3 }, null);
    await persistP3CaseEvidence(aggregate);
    const secondRaw = await readFile(P3_CASE_EVIDENCE_PATH, 'utf8');
    expect(secondRaw).toContain('"a": 2');
    expect(secondRaw).toContain('"b": 3');
    const occurrences = (secondRaw.match(/"caseId":/g) ?? []).length;
    expect(occurrences).toBe(20);
  });

  it('requires exact provenance and terminal PASS evidence for a successful lane', () => {
    let aggregate = newP3CaseEvidence(VALID_PROVENANCE);
    for (const row of aggregate.cases) {
      aggregate = setCaseFinished(aggregate, row.caseId, 'PASS', { caseId: row.caseId }, null);
    }
    expect(() =>
      validateP3CaseEvidenceForSuccess(aggregate, {
        candidateSha: VALID_PROVENANCE.candidateSha,
        runId: VALID_PROVENANCE.runId,
        runAttempt: VALID_PROVENANCE.runAttempt,
        pass: VALID_PROVENANCE.pass,
      }),
    ).not.toThrow();
    expect(() =>
      validateP3CaseEvidenceForSuccess(aggregate, {
        ...VALID_PROVENANCE,
        runId: '999',
      }),
    ).toThrow(/provenance runId/);
  });

  it('uses argv entries after the stdin marker for the workflow verifier', async () => {
    const result = await runNodeStdinArgProbe(
      'evidence.json',
      VALID_PROVENANCE.candidateSha,
      '34540790794',
      '1',
      '1',
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout);
    expect(parsed.slice2).toEqual([
      'evidence.json',
      VALID_PROVENANCE.candidateSha,
      '34540790794',
      '1',
      '1',
    ]);
    expect(parsed.slice1.slice(1)).toEqual(parsed.slice2);
    expect(['-', '[stdin]']).toContain(parsed.slice1[0]);
  });

  it('preserves the prior durable bytes when the temp-to-target rename is refused (fail-closed)', async () => {
    const priorBytes = `${JSON.stringify(
      {
        schemaVersion: P3_CASE_EVIDENCE_SCHEMA_VERSION,
        provenance: VALID_PROVENANCE,
        generatedAt: '2026-09-11T00:00:00.000Z',
        sentinel: 'prior-known-good',
        cases: [],
      },
      null,
      2,
    )}\n`;
    const targetPath = join(workdir, P3_CASE_EVIDENCE_PATH);
    await mkdir(dirname(targetPath), { recursive: true });
    // Seed the prior known-good durable file directly via the real
    // node:fs/promises (the helper's real `writeFile`, not a fake) so the
    // helper sees an existing target and must preserve it on refusal.
    await writeFile(targetPath, priorBytes, 'utf8');
    const tmpPath = `${targetPath}${P3_CASE_EVIDENCE_TMP_SUFFIX}`;
    const recordedCalls = [];
    const removedPaths = [];
    const { rename: realRename } = await import('node:fs/promises');
    const fakeRename = async (src, dst) => {
      recordedCalls.push({ src, dst });
      if (src === tmpPath && dst === targetPath) {
        const err = new Error('synthetic rename-over-target refusal');
        err.code = 'EEXIST';
        throw err;
      }
      return realRename(src, dst);
    };
    const fakeDeps = {
      mkdir,
      writeFile: async (path, data) => writeFile(path, data, 'utf8'),
      rename: fakeRename,
      rm: async (path) => {
        removedPaths.push(path);
        return rm(path, { force: true });
      },
    };

    const aggregate = newP3CaseEvidence(VALID_PROVENANCE);
    let thrown = null;
    try {
      await persistP3CaseEvidence(aggregate, targetPath, fakeDeps);
    } catch (err) {
      thrown = err;
    }

    // The rename-over-target refusal must surface so the caller can react.
    expect(thrown).not.toBeNull();
    expect(thrown.code).toBe('EEXIST');
    // Fail-closed behavior attempts only the temp-to-target rename. It never
    // moves the durable target aside, even briefly.
    expect(recordedCalls).toEqual([{ src: tmpPath, dst: targetPath }]);
    expect(removedPaths).toEqual([tmpPath]);
    // The durable target still holds the prior bytes — the failure path
    // did not destroy the last known-good aggregate.
    const observedBytes = await readFile(targetPath, 'utf8');
    expect(observedBytes).toBe(priorBytes);
    // No temporary file remains from the failed attempt.
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(`${tmpPath}.prev`)).toBe(false);
  });

  it.each(['EEXIST', 'EPERM', 'EBUSY', 'ENOTEMPTY'])(
    'fails closed for overwrite refusal %s without moving the durable target',
    async (code) => {
      const priorBytes = 'prior-known-good-bytes\n';
      const targetPath = join(workdir, P3_CASE_EVIDENCE_PATH);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, priorBytes, 'utf8');
      const tmpPath = `${targetPath}${P3_CASE_EVIDENCE_TMP_SUFFIX}`;
      const calls = [];
      const { rename: realRename } = await import('node:fs/promises');
      const fakeDeps = {
        mkdir,
        writeFile: async (path, data) => writeFile(path, data, 'utf8'),
        rename: async (src, dst) => {
          calls.push({ src, dst });
          const error = new Error(`synthetic ${code}`);
          error.code = code;
          if (src === tmpPath && dst === targetPath) throw error;
          return realRename(src, dst);
        },
        rm: async (path) => rm(path, { force: true }),
      };

      await expect(
        persistP3CaseEvidence(newP3CaseEvidence(VALID_PROVENANCE), targetPath, fakeDeps),
      ).rejects.toMatchObject({ code });
      expect(calls).toEqual([{ src: tmpPath, dst: targetPath }]);
      expect(await readFile(targetPath, 'utf8')).toBe(priorBytes);
      expect(existsSync(tmpPath)).toBe(false);
      expect(existsSync(`${tmpPath}.prev`)).toBe(false);
    },
  );

  it('rethrows non-overwrite rename failures and still removes only the temporary file', async () => {
    const priorBytes = 'prior-known-good-bytes\n';
    const targetPath = join(workdir, P3_CASE_EVIDENCE_PATH);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, priorBytes, 'utf8');
    const tmpPath = `${targetPath}${P3_CASE_EVIDENCE_TMP_SUFFIX}`;
    const error = Object.assign(new Error('synthetic I/O failure'), { code: 'EIO' });
    const fakeDeps = {
      mkdir,
      writeFile: async (path, data) => writeFile(path, data, 'utf8'),
      rename: async () => {
        throw error;
      },
      rm: async (path) => rm(path, { force: true }),
    };

    await expect(
      persistP3CaseEvidence(newP3CaseEvidence(VALID_PROVENANCE), targetPath, fakeDeps),
    ).rejects.toBe(error);
    expect(await readFile(targetPath, 'utf8')).toBe(priorBytes);
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(`${tmpPath}.prev`)).toBe(false);
  });
});

function runNodeStdinArgProbe(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(
      'process.stdout.write(JSON.stringify({ slice1: process.argv.slice(1), slice2: process.argv.slice(2) }));',
    );
  });
}

async function mkWorkdir() {
  const base = join(tmpdir(), 'jm-p3-case-evidence-');
  const dir = join(base, 'work');
  await mkdir(dir, { recursive: true });
  return dir;
}
