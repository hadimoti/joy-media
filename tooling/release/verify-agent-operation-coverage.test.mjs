import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { validateJoyAgentOperationCoverage } from './verify-agent-operation-coverage.mjs';

const coverage = JSON.parse(
  readFileSync(
    new URL('../../docs/reviews/joy-live-director-coverage.json', import.meta.url),
    'utf8',
  ),
);
const expectedKinds = coverage.operations.map((entry) => entry.kind);
const allPathsExist = () => true;

function validate(candidate) {
  return validateJoyAgentOperationCoverage({
    coverage: candidate,
    expectedKinds,
    fileExists: allPathsExist,
  });
}

test('accepts the checked-in bounded capability ledger', () => {
  assert.doesNotThrow(() => validate(structuredClone(coverage)));
});

test('rejects an advertised operation without declared browser evidence', () => {
  const candidate = structuredClone(coverage);
  candidate.operations[0].e2eEvidence.evidence = [];

  assert.throws(() => validate(candidate), /e2eEvidence\.evidence must contain at least one path/);
});

test('rejects a shared lifecycle test used to claim full domain parity', () => {
  const candidate = structuredClone(coverage);
  candidate.operations[0].verificationScope = 'domain-e2e';

  assert.throws(() => validate(candidate), /needs operation-specific E2E evidence for domain-e2e/);
});

test('rejects a bounded proposal path that claims semantic readback', () => {
  const candidate = structuredClone(coverage);
  candidate.operations[0].readback = {
    classification: 'project-state-only',
    evidence: ['apps/editor-web/src/joy-code-compound-runner.test.ts'],
    reason: 'A forged full-parity claim for the negative case.',
  };

  assert.throws(
    () => validate(candidate),
    /cannot claim semantic readback from a bounded proposal-only path/,
  );
});
