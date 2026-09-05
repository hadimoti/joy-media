/* global console, process */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const fromRoot = (path) => resolve(root, path);
const fail = (message) => {
  throw new Error(`JOY agent coverage: ${message}`);
};
const read = (path) => readFileSync(fromRoot(path), 'utf8');

const coveragePath = 'docs/reviews/joy-live-director-coverage.json';
const coverage = JSON.parse(read(coveragePath));
if (coverage.schemaVersion !== 1 || !Array.isArray(coverage.operations))
  fail('coverage ledger has an unsupported shape');

const planSource = read('packages/agent-tools/src/joy-code-plan.ts');
const operationList = planSource.match(
  /export const JOY_CODE_OPERATION_KINDS = \[([\s\S]*?)\] as const;/,
);
if (!operationList) fail('could not find JOY_CODE_OPERATION_KINDS');
const expectedKinds = [...operationList[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
const coveredKinds = coverage.operations.map((entry) => entry.kind);
if (new Set(coveredKinds).size !== coveredKinds.length)
  fail('duplicate operation kind in coverage ledger');
if (
  expectedKinds.length !== coveredKinds.length ||
  expectedKinds.some((kind) => !coveredKinds.includes(kind))
)
  fail('ledger must include exactly every Joy Code operation kind');

for (const entry of coverage.operations) {
  if (entry.status === 'verified') {
    if (typeof entry.source !== 'string' || !existsSync(fromRoot(entry.source)))
      fail(`${entry.kind} has no existing source evidence`);
    if (!Array.isArray(entry.tests) || entry.tests.length === 0)
      fail(`${entry.kind} has no focused test evidence`);
    for (const test of entry.tests)
      if (typeof test !== 'string' || !existsSync(fromRoot(test)))
        fail(`${entry.kind} references missing test ${String(test)}`);
  }
  if (!Array.isArray(entry.postconditions) || entry.postconditions.length === 0)
    fail(`${entry.kind} has no declared postcondition`);
}

const registrySource = read('packages/agent-tools/src/editor-operation-registry.ts');
for (const kind of expectedKinds)
  if (!registrySource.includes(`'${kind}'`)) fail(`registry does not declare ${kind}`);

const workerSource = read('apps/editor-web/src/joy-agent/engine.worker.ts');
if (!workerSource.includes('listModelVisibleJoyEditorOperations()'))
  fail('Worker does not derive its model catalog from the host registry');

console.log(
  `JOY agent coverage verified: ${coverage.operations.length} bounded operations; ${coverage.domainInventory.filter((entry) => entry.status === 'unsupported').length} domains explicitly unsupported.`,
);
