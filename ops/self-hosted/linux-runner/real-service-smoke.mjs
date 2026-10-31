#!/usr/bin/env node
/* global process */

// pg is a root devDependency for ci-namespace-janitor.mjs; this retired smoke script no longer loads it or the removed API package.
const message =
  'Real-service smoke is retired on this local-only branch. PLAN-v4 §8b removes this lane; use the fixture-only acceptance suite.';
process.stderr.write(`${message}\n`);
process.exitCode = 2;
