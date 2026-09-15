#!/usr/bin/env node
/* Shared P3 export matrix case registry + validator.
 *
 * Pure ESM with zero filesystem / network / DOM access. Imported by:
 *   - tests/e2e/r2-p3-shipping-export-acceptance.spec.ts (Playwright browser)
 *   - ops/self-hosted/linux-runner/real-service-acceptance.mjs (CI harness)
 *   - ops/self-hosted/linux-runner/p3-case-registry.test.mjs (vitest unit tests)
 *
 * R2 ships exactly five Look packs. Persian Editorial was retired 2026-09-08
 * (see packages/motion-core/src/looks/packs/index.ts). The five ids are the
 * same canonical ids used by @joy-media/motion-core's BUILT_IN_LOOK_PACKS.
 * Hard-coding the list here is intentional: a registry that silently grew or
 * shrank would defeat the 20-row contract; this file fails closed at module
 * load if the harness ever tries to register a different set.
 */

export const P3_PACK_IDS = Object.freeze([
  'editorial-clean',
  'product-precision',
  'kinetic-type',
  'quiet-documentary',
  'music-pulse',
]);

export const P3_PACK_LABELS = Object.freeze({
  'editorial-clean': 'Editorial Clean',
  'product-precision': 'Product Precision',
  'kinetic-type': 'Kinetic Type',
  'quiet-documentary': 'Quiet Documentary',
  'music-pulse': 'Music Pulse',
});

export const P3_PRESETS = Object.freeze([
  Object.freeze({ id: 'reels-1080', label: 'Reels 1080×1920', width: 1080, height: 1920 }),
  Object.freeze({ id: 'youtube-1080', label: 'YouTube 1920×1080', width: 1920, height: 1080 }),
]);

export const P3_CASE_KINDS = Object.freeze(['export', 'cancel']);

export const P3_RESULTS = Object.freeze(['NOT RUN', 'PASS', 'FAIL']);
export const P3_PHASES = Object.freeze(['NOT RUN', 'started', 'PASS', 'FAIL']);
const PROVENANCE_FIELDS = Object.freeze(['candidateSha', 'runId', 'runAttempt', 'pass']);

function buildRegistry() {
  if (P3_PACK_IDS.length !== 5) {
    throw new Error(`p3-case-registry: expected exactly 5 Look packs, got ${P3_PACK_IDS.length}`);
  }
  if (P3_PRESETS.length !== 2) {
    throw new Error(`p3-case-registry: expected exactly 2 presets, got ${P3_PRESETS.length}`);
  }
  const packs = P3_PACK_IDS.map((id) => Object.freeze({ id, title: P3_PACK_LABELS[id] ?? id }));
  const rows = [];
  for (const pack of packs) {
    for (const preset of P3_PRESETS) {
      for (const kind of P3_CASE_KINDS) {
        const caseId =
          kind === 'cancel' ? `cancel/${pack.id}/${preset.id}` : `${pack.id}/${preset.id}`;
        rows.push(
          Object.freeze({
            caseId,
            pack: pack.id,
            preset: preset.id,
            kind,
            phase: 'NOT RUN',
            result: 'NOT RUN',
            reason: null,
          }),
        );
      }
    }
  }
  if (rows.length !== 20) {
    throw new Error(`p3-case-registry: expected exactly 20 case rows, got ${rows.length}`);
  }
  const byId = new Map(rows.map((row) => [row.caseId, row]));
  if (byId.size !== rows.length) {
    throw new Error('p3-case-registry: duplicate caseId produced');
  }
  return Object.freeze({
    packs: Object.freeze(packs),
    presets: P3_PRESETS,
    kinds: P3_CASE_KINDS,
    rows: Object.freeze(rows),
    byId: Object.freeze(byId),
  });
}

export const P3_CASE_REGISTRY = buildRegistry();

export function isP3CaseId(caseId) {
  return P3_CASE_REGISTRY.byId.has(caseId);
}

export function getP3Case(caseId) {
  return P3_CASE_REGISTRY.byId.get(caseId) ?? null;
}

export function newP3Matrix() {
  return P3_CASE_REGISTRY.rows.map((row) => ({
    caseId: row.caseId,
    pack: row.pack,
    preset: row.preset,
    kind: row.kind,
    phase: 'NOT RUN',
    result: 'NOT RUN',
    reason: null,
  }));
}

/**
 * Mark a single case as started. Returns a NEW matrix (immutable); caller
 * MUST persist atomically. The validator distinguishes `phase: 'started'`
 * from `result: 'PASS'/'FAIL'`, so an interrupted run is honestly reported
 * as FAIL-with-reason instead of being silently promoted to PASS by a
 * second pass that never started.
 */
export function markStarted(matrix, caseId, reason = null) {
  const idx = matrix.findIndex((r) => r.caseId === caseId);
  if (idx === -1) throw new Error(`p3-case-registry: unknown caseId ${caseId}`);
  const current = matrix[idx];
  if (current.result === 'PASS') return matrix;
  // Preserve every field not explicitly being changed so provenance (and any
  // future per-row metadata) survives the full-matrix call shape. Splicing a
  // freshly-built row would silently drop sibling metadata.
  const updated = {
    ...current,
    phase: 'started',
    reason: reason === null ? current.reason : String(reason),
  };
  const next = matrix.slice();
  next[idx] = updated;
  return next;
}

export function markResult(matrix, caseId, result, reason = null) {
  if (result !== 'PASS' && result !== 'FAIL') {
    throw new Error(`p3-case-registry: invalid result ${String(result)}`);
  }
  const idx = matrix.findIndex((r) => r.caseId === caseId);
  if (idx === -1) throw new Error(`p3-case-registry: unknown caseId ${caseId}`);
  const current = matrix[idx];
  const updated = {
    ...current,
    phase: result,
    result,
    reason: reason === null ? current.reason : String(reason),
  };
  const next = matrix.slice();
  next[idx] = updated;
  return next;
}

export function attachProvenance(matrix, provenance) {
  return matrix.map((row) => ({ ...row, provenance: { ...provenance } }));
}

/**
 * Provenance contract. The CI harness MUST inject candidate/run/attempt/pass
 * and a UTC issuedAt timestamp; the browser spec records candidate + run
 * from env. A mismatch fails the lane — provenance prevents a stale matrix
 * from one attempt being carried into another.
 */
export function p3Provenance({ candidateSha, runId, runAttempt, pass, issuedAt }) {
  if (typeof candidateSha !== 'string' || !/^[0-9a-f]{40}$/.test(candidateSha)) {
    throw new Error(`p3-case-registry: invalid candidateSha ${String(candidateSha)}`);
  }
  if (typeof runId !== 'string' || !/^\d+$/.test(runId)) {
    throw new Error(`p3-case-registry: invalid runId ${String(runId)}`);
  }
  if (typeof runAttempt !== 'string' || !/^\d+$/.test(runAttempt)) {
    throw new Error(`p3-case-registry: invalid runAttempt ${String(runAttempt)}`);
  }
  if (pass !== '1' && pass !== '2') {
    throw new Error(`p3-case-registry: invalid pass ${String(pass)}`);
  }
  if (typeof issuedAt !== 'string' || Number.isNaN(Date.parse(issuedAt))) {
    throw new Error(`p3-case-registry: invalid issuedAt ${String(issuedAt)}`);
  }
  return Object.freeze({
    candidateSha,
    runId,
    runAttempt,
    pass,
    issuedAt,
  });
}

/**
 * Validate a P3 export matrix. Rejects:
 *   - wrong length (not exactly 20 rows)
 *   - duplicates
 *   - unknown / missing case identities
 *   - wrong pack/preset/kind per row
 *   - result other than PASS / FAIL / NOT RUN
 *   - any FAIL or NOT RUN row
 *   - provenance mismatch (when provided)
 *
 * Returns `{ ok: true, matrix, provenance }` on success, otherwise
 * `{ ok: false, error, problems }`. The harness MUST treat `ok: false` as a
 * hard lane failure with no downgrade to ten rows.
 */
export function validateP3Matrix(matrix, expectedProvenance) {
  const problems = [];
  if (!Array.isArray(matrix)) {
    return { ok: false, error: 'matrix is not an array', problems: ['matrix:not-array'] };
  }
  if (matrix.length !== P3_CASE_REGISTRY.rows.length) {
    problems.push(`matrix:length=${matrix.length}, expected ${P3_CASE_REGISTRY.rows.length}`);
  }
  if (expectedProvenance !== undefined) {
    const provError = checkProvenance(matrix, expectedProvenance);
    if (provError !== null) problems.push(`provenance:${provError}`);
  }
  const seen = new Set();
  for (const row of matrix) {
    if (row === null || typeof row !== 'object') {
      problems.push('row:not-object');
      continue;
    }
    if (typeof row.caseId !== 'string') {
      problems.push('row:caseId-not-string');
      continue;
    }
    if (seen.has(row.caseId)) {
      problems.push(`duplicate:${row.caseId}`);
      continue;
    }
    seen.add(row.caseId);
    const expected = P3_CASE_REGISTRY.byId.get(row.caseId);
    if (expected === undefined) {
      problems.push(`unknown:${row.caseId}`);
      continue;
    }
    if (row.pack !== expected.pack) {
      problems.push(`wrong-pack:${row.caseId}:${row.pack}!=${expected.pack}`);
    }
    if (row.preset !== expected.preset) {
      problems.push(`wrong-preset:${row.caseId}:${row.preset}!=${expected.preset}`);
    }
    if (row.kind !== expected.kind) {
      problems.push(`wrong-kind:${row.caseId}:${row.kind}!=${expected.kind}`);
    }
    if (!P3_RESULTS.includes(row.result)) {
      problems.push(`bad-result:${row.caseId}:${String(row.result)}`);
    } else if (row.result !== 'PASS') {
      problems.push(`not-pass:${row.caseId}:${row.result}`);
    }
    if (!P3_PHASES.includes(row.phase)) {
      problems.push(`bad-phase:${row.caseId}:${String(row.phase)}`);
    }
  }
  for (const expected of P3_CASE_REGISTRY.rows) {
    if (!seen.has(expected.caseId)) problems.push(`missing:${expected.caseId}`);
  }
  if (problems.length > 0) {
    return { ok: false, error: `P3 matrix invalid: ${problems.length} problem(s)`, problems };
  }
  return { ok: true, matrix, provenance: expectedProvenance };
}

function checkProvenance(matrix, expected) {
  if (matrix.length === 0) return null;
  let issuedAt;
  for (let index = 0; index < matrix.length; index += 1) {
    const provenance = matrix[index]?.provenance;
    if (typeof provenance !== 'object' || provenance === null) {
      return `missing-on-row:${index}`;
    }
    if (typeof provenance.issuedAt !== 'string' || Number.isNaN(Date.parse(provenance.issuedAt))) {
      return `invalid-issuedAt:${index}`;
    }
    if (issuedAt === undefined) issuedAt = provenance.issuedAt;
    if (provenance.issuedAt !== issuedAt) {
      return `mismatch:issuedAt:${String(provenance.issuedAt)}!=${String(issuedAt)}`;
    }
    if (expected.issuedAt !== undefined && provenance.issuedAt !== expected.issuedAt) {
      return `mismatch:issuedAt:${String(provenance.issuedAt)}!=${String(expected.issuedAt)}`;
    }
    for (const field of PROVENANCE_FIELDS) {
      if (expected[field] !== undefined && provenance[field] !== expected[field]) {
        return `mismatch:${field}:${String(provenance[field])}!=${String(expected[field])}`;
      }
    }
  }
  return null;
}
