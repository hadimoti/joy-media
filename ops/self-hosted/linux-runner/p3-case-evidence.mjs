#!/usr/bin/env node
/* Per-case P3 evidence aggregate.
 *
 * Pure ESM with zero filesystem / network / DOM access for the data-shape
 * helpers (`newP3CaseEvidence`, `setCaseStarted`, `setCaseFinished`); the
 * atomic file persistence is one thin `persistP3CaseEvidence` helper that
 * uses node:fs/promises the same way the matrix persistence does.
 *
 * The aggregate persists rich per-case evidence that the P3 spec already
 * constructs (projectBefore / projectAfter / persisted timeline expectations,
 * ffprobe data, early/mid/late sync events, Music Pulse bake provenance,
 * decoded pixel samples, spatial checks, gallery entry). The matrix only
 * records `phase` / `result` / `reason`; a downstream reader needs the
 * supporting values to independently verify a case. The retention script
 * allowlists this file so a durable, redacted, checksum-verified copy of
 * the rich evidence survives the lane.
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { P3_PHASES, P3_RESULTS, P3_CASE_REGISTRY } from './p3-case-registry.mjs';

/** Default dependency bundle for `persistP3CaseEvidence`. The DI seam is
 *  internal-only: production callers should not pass `deps`. The bundle
 *  captures the four filesystem primitives the helper uses so a unit test
 *  can substitute deterministic fakes without touching globals. */
function defaultPersistDeps() {
  return { mkdir, rename, rm, writeFile };
}

export const P3_CASE_EVIDENCE_SCHEMA_VERSION = 1;

export const P3_CASE_EVIDENCE_PATH = 'test-output/browser/p3-case-evidence.json';
export const P3_CASE_EVIDENCE_TMP_SUFFIX = '.tmp';

/** Stable initial state for one case row: `NOT RUN` with no error and no
 *  evidence payload. A row that is still `NOT RUN` at retention time is
 *  proof that the case never started (e.g. an early auth/webServer failure);
 *  the matrix may already say so, but the aggregate has to agree. */
function initialCaseRow({ caseId, pack, preset, kind }) {
  return {
    caseId,
    pack,
    preset,
    kind,
    phase: 'NOT RUN',
    result: 'NOT RUN',
    reason: null,
    error: null,
    evidence: null,
  };
}

/** Build the initial 20-case aggregate for the given provenance. Every
 *  known registry case is present in `NOT RUN` order. The canonical rows are
 *  derived from `P3_CASE_REGISTRY.rows` so the helper cannot drift from the
 *  matrix. */
export function newP3CaseEvidence(provenance) {
  const rows = P3_CASE_REGISTRY.rows.map((row) => initialCaseRow(row));
  return {
    schemaVersion: P3_CASE_EVIDENCE_SCHEMA_VERSION,
    provenance: { ...provenance },
    generatedAt: new Date().toISOString(),
    cases: rows,
  };
}

/** Return a NEW aggregate with `caseId` marked `started` with the given
 *  reason. Throws if `caseId` is not in the aggregate. The phase/result
 *  separation mirrors `markStarted` in p3-case-registry so an interrupted
 *  case is honestly reported as `phase: started, result: NOT RUN` until the
 *  finally block runs `setCaseFinished`. */
export function setCaseStarted(aggregate, caseId, reason = null) {
  const index = aggregate.cases.findIndex((row) => row.caseId === caseId);
  if (index === -1) throw new Error(`p3-case-evidence: unknown caseId ${caseId}`);
  const current = aggregate.cases[index];
  if (current.result === 'PASS') return aggregate;
  const nextCases = aggregate.cases.slice();
  nextCases[index] = {
    ...current,
    phase: 'started',
    reason: reason === null ? current.reason : String(reason),
  };
  return {
    ...aggregate,
    cases: nextCases,
  };
}

/** Return a NEW aggregate with `caseId` terminal PASS or FAIL plus the
 *  full evidence object the P3 spec built (may be `null` if the case never
 *  produced evidence — e.g. a click error before any observer fired). */
export function setCaseFinished(aggregate, caseId, result, evidence, error = null) {
  if (result !== 'PASS' && result !== 'FAIL') {
    throw new Error(`p3-case-evidence: invalid result ${String(result)}`);
  }
  const index = aggregate.cases.findIndex((row) => row.caseId === caseId);
  if (index === -1) throw new Error(`p3-case-evidence: unknown caseId ${caseId}`);
  const current = aggregate.cases[index];
  const nextCases = aggregate.cases.slice();
  nextCases[index] = {
    ...current,
    phase: result,
    result,
    reason: error === null ? current.reason : String(error),
    error: error === null ? current.error : String(error),
    evidence: evidence === undefined ? current.evidence : evidence,
  };
  return {
    ...aggregate,
    cases: nextCases,
  };
}

/** Atomically persist the aggregate. Writes the new payload to a sibling
 *  `.tmp` and renames it over the durable target. The durable target is
 *  never removed or moved before the rename succeeds, so every failed
 *  replacement leaves the previous known-good bytes in place. On platforms
 *  whose `rename` refuses to overwrite an existing destination (Windows
 *  raises EEXIST / EPERM / EBUSY / ENOTEMPTY), the helper fails closed: it
 *  removes only the newly-written temporary file and rethrows the original
 *  error. A caller can retry with an appropriate platform-specific primitive;
 *  this helper never creates a window in which the required durable path is
 *  absent. Throws on any I/O failure so the caller can decide whether to log
 *  + continue or fail the case.
 *
 *  The optional `deps` argument is an internal-only dependency-injection
 *  seam used by the unit tests to substitute the filesystem functions.
 *  Callers (and production code) should leave it unset; the defaults are
 *  the real `node:fs/promises` bindings. The seam exists only so a test
 *  can deterministically simulate a rename-over-target refusal without
 *  monkey-patching globals or spawning a child process. */
export async function persistP3CaseEvidence(
  aggregate,
  targetPath = P3_CASE_EVIDENCE_PATH,
  deps = defaultPersistDeps(),
) {
  await deps.mkdir(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}${P3_CASE_EVIDENCE_TMP_SUFFIX}`;
  const payload = `${JSON.stringify(aggregate, null, 2)}\n`;
  try {
    await deps.writeFile(tmp, payload, 'utf8');
    await deps.rename(tmp, targetPath);
  } catch (error) {
    // Fail closed on every write/rename error: the durable target was never
    // touched, and only the new temporary file is disposable state.
    await deps.rm(tmp, { force: true });
    throw error;
  }
}

/** Validate the shape of a serialized aggregate. Used by the unit tests and
 *  by anything that wants to confirm a recovered file is well-formed before
 *  reading individual rows. Throws on any structural problem. */
export function validateP3CaseEvidenceShape(aggregate) {
  if (aggregate === null || typeof aggregate !== 'object') {
    throw new Error('p3-case-evidence: aggregate is not an object');
  }
  if (aggregate.schemaVersion !== P3_CASE_EVIDENCE_SCHEMA_VERSION) {
    throw new Error(
      `p3-case-evidence: schemaVersion=${String(aggregate.schemaVersion)} != ${P3_CASE_EVIDENCE_SCHEMA_VERSION}`,
    );
  }
  if (aggregate.provenance === null || typeof aggregate.provenance !== 'object') {
    throw new Error('p3-case-evidence: provenance missing');
  }
  if (
    typeof aggregate.provenance.candidateSha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(aggregate.provenance.candidateSha)
  ) {
    throw new Error('p3-case-evidence: provenance candidateSha invalid');
  }
  for (const field of ['runId', 'runAttempt']) {
    if (
      typeof aggregate.provenance[field] !== 'string' ||
      !/^\d+$/.test(aggregate.provenance[field])
    ) {
      throw new Error(`p3-case-evidence: provenance ${field} invalid`);
    }
  }
  if (aggregate.provenance.pass !== '1' && aggregate.provenance.pass !== '2') {
    throw new Error('p3-case-evidence: provenance pass invalid');
  }
  if (
    typeof aggregate.provenance.issuedAt !== 'string' ||
    Number.isNaN(Date.parse(aggregate.provenance.issuedAt))
  ) {
    throw new Error('p3-case-evidence: provenance issuedAt invalid');
  }
  if (
    typeof aggregate.generatedAt !== 'string' ||
    Number.isNaN(Date.parse(aggregate.generatedAt))
  ) {
    throw new Error('p3-case-evidence: generatedAt invalid');
  }
  if (!Array.isArray(aggregate.cases)) {
    throw new Error('p3-case-evidence: cases is not an array');
  }
  if (aggregate.cases.length !== P3_CASE_REGISTRY.rows.length) {
    throw new Error(
      `p3-case-evidence: cases.length=${aggregate.cases.length} != ${P3_CASE_REGISTRY.rows.length}`,
    );
  }
  const seen = new Set();
  for (const [index, row] of aggregate.cases.entries()) {
    if (row === null || typeof row !== 'object') {
      throw new Error('p3-case-evidence: row is not an object');
    }
    if (typeof row.caseId !== 'string') throw new Error('p3-case-evidence: row.caseId missing');
    if (seen.has(row.caseId)) throw new Error(`p3-case-evidence: duplicate ${row.caseId}`);
    seen.add(row.caseId);
    const expected = P3_CASE_REGISTRY.rows[index];
    if (expected === undefined || row.caseId !== expected.caseId) {
      throw new Error(`p3-case-evidence: case identity mismatch at index ${index}`);
    }
    for (const field of ['pack', 'preset', 'kind']) {
      if (row[field] !== expected[field]) {
        throw new Error(`p3-case-evidence: ${row.caseId} ${field} mismatch`);
      }
    }
    if (!P3_PHASES.includes(row.phase)) {
      throw new Error(`p3-case-evidence: ${row.caseId} phase invalid`);
    }
    if (!P3_RESULTS.includes(row.result)) {
      throw new Error(`p3-case-evidence: ${row.caseId} result invalid`);
    }
    if (row.result === 'NOT RUN' && row.phase !== 'NOT RUN' && row.phase !== 'started') {
      throw new Error(`p3-case-evidence: ${row.caseId} NOT RUN phase mismatch`);
    }
    if (row.result !== 'NOT RUN' && row.phase !== row.result) {
      throw new Error(`p3-case-evidence: ${row.caseId} terminal phase mismatch`);
    }
    if (row.reason !== null && typeof row.reason !== 'string') {
      throw new Error(`p3-case-evidence: ${row.caseId} reason invalid`);
    }
    if (row.error !== null && typeof row.error !== 'string') {
      throw new Error(`p3-case-evidence: ${row.caseId} error invalid`);
    }
    if (
      row.evidence !== null &&
      (typeof row.evidence !== 'object' || Array.isArray(row.evidence))
    ) {
      throw new Error(`p3-case-evidence: ${row.caseId} evidence invalid`);
    }
  }
  return aggregate;
}

/** Validate the stronger contract required for a successful retained P3 lane. */
export function validateP3CaseEvidenceForSuccess(aggregate, expectedProvenance) {
  validateP3CaseEvidenceShape(aggregate);
  for (const field of ['candidateSha', 'runId', 'runAttempt', 'pass']) {
    if (
      expectedProvenance?.[field] !== undefined &&
      aggregate.provenance[field] !== expectedProvenance[field]
    ) {
      throw new Error(
        `p3-case-evidence: provenance ${field}=${String(aggregate.provenance[field])} != ${String(expectedProvenance[field])}`,
      );
    }
  }
  for (const row of aggregate.cases) {
    if (row.result !== 'PASS' || row.phase !== 'PASS') {
      throw new Error(`p3-case-evidence: ${row.caseId} is not terminal PASS`);
    }
    if (row.evidence === null) {
      throw new Error(`p3-case-evidence: ${row.caseId} evidence missing`);
    }
  }
  return aggregate;
}
