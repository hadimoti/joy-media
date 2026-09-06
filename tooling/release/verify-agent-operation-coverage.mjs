/* global console, process */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const JOY_AGENT_COVERAGE_STATUSES = Object.freeze([
  'verified',
  'unsupported',
  'read-only',
  'internal-inverse',
  'legacy-disabled',
]);

const COVERAGE_STATUS_SET = new Set(JOY_AGENT_COVERAGE_STATUSES);
const MODEL_VISIBILITY_SET = new Set(['advertised', 'withheld']);
const PARITY_SCOPE_SET = new Set([
  'bounded-proposal-path',
  'domain-e2e',
  'rendered-output-e2e',
  'audio-output-e2e',
  'external-job-e2e',
  'not-implemented',
]);
const E2E_CLASSIFICATION_SET = new Set([
  'operation-specific',
  'shared-host-lifecycle',
  'not-covered',
]);
const PREVIEW_CLASSIFICATION_SET = new Set([
  'none',
  'staged-draft',
  'staged-draft-with-shared-renderer-ack',
  'operation-specific-renderer-ack',
  'rendered-frame-verified',
]);
const READBACK_CLASSIFICATION_SET = new Set([
  'not-verified',
  'project-state-only',
  'rendered-output',
  'audio-mix',
  'external-job-receipt',
]);

const isNonBlankString = (value) => typeof value === 'string' && value.trim().length > 0;
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(message) {
  throw new Error(`JOY agent coverage: ${message}`);
}

function assertKnownStatus(status, label) {
  if (!COVERAGE_STATUS_SET.has(status)) fail(`${label} has unsupported status ${String(status)}`);
}

function assertExistingPath(path, label, fileExists) {
  if (!isNonBlankString(path)) fail(`${label} must be a non-empty path`);
  if (!fileExists(path)) fail(`${label} references missing path ${path}`);
}

function assertPathList(paths, label, fileExists, { required }) {
  if (!Array.isArray(paths) || (required && paths.length === 0))
    fail(`${label} must contain ${required ? 'at least one' : 'a'} path`);
  for (const path of paths) assertExistingPath(path, label, fileExists);
}

function assertEvidenceList(evidence, label, fileExists) {
  if (!Array.isArray(evidence) || evidence.length === 0)
    fail(`${label} must contain at least one focused evidence row`);
  for (const [index, row] of evidence.entries()) {
    if (!isRecord(row)) fail(`${label}[${index}] must be an object`);
    assertExistingPath(row.path, `${label}[${index}].path`, fileExists);
    if (!isNonBlankString(row.scope)) fail(`${label}[${index}] must state its coverage scope`);
  }
}

function assertClassification(record, label, allowed, fileExists, { evidenceRequired }) {
  if (!isRecord(record)) fail(`${label} must be an object`);
  if (!allowed.has(record.classification))
    fail(`${label} has unsupported classification ${String(record.classification)}`);
  if (!isNonBlankString(record.reason)) fail(`${label} must explain its classification`);
  if (record.evidence !== undefined)
    assertPathList(record.evidence, `${label}.evidence`, fileExists, {
      required: evidenceRequired,
    });
  else if (evidenceRequired) fail(`${label} requires source-backed evidence`);
}

/**
 * Validate the checked-in capability ledger without importing browser code.
 * The function is exported so a small Node test can keep the release gate's
 * negative cases honest without executing a release command in a fixture.
 */
export function validateJoyAgentOperationCoverage({ coverage, expectedKinds, fileExists }) {
  if (!isRecord(coverage) || coverage.schemaVersion !== 2 || !Array.isArray(coverage.operations))
    fail('coverage ledger has an unsupported shape or schemaVersion');
  if (!Array.isArray(expectedKinds) || expectedKinds.length === 0)
    fail('expected Joy Code operation kinds are required');
  if (typeof fileExists !== 'function') fail('a file existence predicate is required');
  if (!Array.isArray(coverage.domainInventory) || coverage.domainInventory.length === 0)
    fail('coverage ledger must include a domain inventory');
  if (!isNonBlankString(coverage.advertisingRule) || !isNonBlankString(coverage.parityRule))
    fail('coverage ledger must declare advertising and parity rules');

  const domainById = new Map();
  for (const [index, domain] of coverage.domainInventory.entries()) {
    if (!isRecord(domain) || !isNonBlankString(domain.id))
      fail(`domainInventory[${index}] requires an id`);
    if (domainById.has(domain.id)) fail(`duplicate domain inventory id ${domain.id}`);
    assertKnownStatus(domain.status, `domain ${domain.id}`);
    if (!PARITY_SCOPE_SET.has(domain.verificationScope))
      fail(`domain ${domain.id} has unsupported parity scope ${String(domain.verificationScope)}`);
    if (!isNonBlankString(domain.reason)) fail(`domain ${domain.id} requires a truthful reason`);
    if (!Array.isArray(domain.operationKinds))
      fail(`domain ${domain.id} must list its operation kinds, even when empty`);
    domainById.set(domain.id, domain);
  }

  const coveredKinds = coverage.operations.map((entry) => entry?.kind);
  if (new Set(coveredKinds).size !== coveredKinds.length)
    fail('duplicate operation kind in coverage ledger');
  if (
    expectedKinds.length !== coveredKinds.length ||
    expectedKinds.some((kind) => !coveredKinds.includes(kind))
  )
    fail('ledger must include exactly every Joy Code operation kind');

  for (const [index, entry] of coverage.operations.entries()) {
    if (!isRecord(entry) || !isNonBlankString(entry.kind))
      fail(`operations[${index}] requires a kind`);
    if (!isNonBlankString(entry.domain) || !domainById.has(entry.domain))
      fail(`${entry.kind} must name an inventoried domain`);
    assertKnownStatus(entry.status, entry.kind);
    if (!MODEL_VISIBILITY_SET.has(entry.modelVisibility))
      fail(`${entry.kind} has unsupported model visibility ${String(entry.modelVisibility)}`);
    if (!PARITY_SCOPE_SET.has(entry.verificationScope))
      fail(`${entry.kind} has unsupported parity scope ${String(entry.verificationScope)}`);
    if (!isNonBlankString(entry.statusReason))
      fail(`${entry.kind} must explain why its status is truthful`);
    if (!Array.isArray(entry.postconditions) || entry.postconditions.length === 0)
      fail(`${entry.kind} has no declared postcondition`);
    if (entry.postconditions.some((condition) => !isNonBlankString(condition)))
      fail(`${entry.kind} has an empty postcondition`);

    const isAdvertised = entry.modelVisibility === 'advertised';
    if (isAdvertised && entry.status !== 'verified')
      fail(`${entry.kind} is advertised but is not verified`);
    if (!isAdvertised && entry.status === 'verified')
      fail(
        `${entry.kind} is verified but withheld; declare it advertised or explain its limitation`,
      );

    // A verified, model-visible row is deliberately stricter than the old
    // source-plus-test marker. It must tell release review what the unit path
    // proves, what browser evidence exists, what kind of preview occurred,
    // and whether a semantic readback is still missing.
    if (isAdvertised) {
      assertExistingPath(entry.source, `${entry.kind}.source`, fileExists);
      assertEvidenceList(entry.unitEvidence, `${entry.kind}.unitEvidence`, fileExists);
      assertClassification(
        entry.e2eEvidence,
        `${entry.kind}.e2eEvidence`,
        E2E_CLASSIFICATION_SET,
        fileExists,
        { evidenceRequired: true },
      );
      assertClassification(
        entry.preview,
        `${entry.kind}.preview`,
        PREVIEW_CLASSIFICATION_SET,
        fileExists,
        { evidenceRequired: entry.preview?.classification !== 'none' },
      );
      assertClassification(
        entry.readback,
        `${entry.kind}.readback`,
        READBACK_CLASSIFICATION_SET,
        fileExists,
        { evidenceRequired: entry.readback?.classification !== 'not-verified' },
      );

      // A shared lifecycle test proves the host envelope, not the exact
      // creative result. Keep that limitation mechanically visible so this
      // ledger cannot accidentally turn a compiler-only operation into a
      // claimed full editor parity feature.
      if (
        entry.e2eEvidence.classification !== 'operation-specific' &&
        entry.verificationScope !== 'bounded-proposal-path'
      )
        fail(`${entry.kind} needs operation-specific E2E evidence for ${entry.verificationScope}`);
      if (
        entry.verificationScope === 'bounded-proposal-path' &&
        entry.readback.classification !== 'not-verified'
      )
        fail(`${entry.kind} cannot claim semantic readback from a bounded proposal-only path`);
    } else if (!isNonBlankString(entry.reason)) {
      fail(`${entry.kind} is withheld and requires a concrete reason`);
    }

    const domain = domainById.get(entry.domain);
    if (!domain.operationKinds.includes(entry.kind))
      fail(`${entry.kind} is missing from domain ${entry.domain}'s operation inventory`);
  }

  for (const domain of domainById.values()) {
    for (const kind of domain.operationKinds) {
      const operation = coverage.operations.find((entry) => entry.kind === kind);
      if (operation?.domain !== domain.id)
        fail(`domain ${domain.id} references unknown or mismatched operation ${kind}`);
    }
    if (domain.status === 'unsupported' && domain.operationKinds.length > 0)
      fail(`unsupported domain ${domain.id} cannot contain any operation kinds`);
  }

  return {
    operationCount: coverage.operations.length,
    unsupportedDomainCount: coverage.domainInventory.filter(
      (entry) => entry.status === 'unsupported',
    ).length,
  };
}

export function verifyJoyAgentOperationCoverage({ root = process.cwd() } = {}) {
  const fromRoot = (path) => resolve(root, path);
  const read = (path) => readFileSync(fromRoot(path), 'utf8');
  const coveragePath = 'docs/reviews/joy-live-director-coverage.json';
  const coverage = JSON.parse(read(coveragePath));

  const planSource = read('packages/agent-tools/src/joy-code-plan.ts');
  const operationList = planSource.match(
    /export const JOY_CODE_OPERATION_KINDS = \[([\s\S]*?)\] as const;/,
  );
  if (!operationList) fail('could not find JOY_CODE_OPERATION_KINDS');
  const expectedKinds = [...operationList[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const result = validateJoyAgentOperationCoverage({
    coverage,
    expectedKinds,
    fileExists: (path) => existsSync(fromRoot(path)),
  });

  const registrySource = read('packages/agent-tools/src/editor-operation-registry.ts');
  for (const kind of expectedKinds)
    if (!registrySource.includes(`'${kind}'`)) fail(`registry does not declare ${kind}`);

  const workerSource = read('apps/editor-web/src/joy-agent/engine.worker.ts');
  if (!workerSource.includes('listModelVisibleJoyEditorOperations()'))
    fail('Worker does not derive its model catalog from the host registry');

  return result;
}

const executedAsScript =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (executedAsScript) {
  const result = verifyJoyAgentOperationCoverage();
  console.log(
    `JOY agent coverage verified: ${result.operationCount} bounded operations; ${result.unsupportedDomainCount} domains explicitly unsupported.`,
  );
}
