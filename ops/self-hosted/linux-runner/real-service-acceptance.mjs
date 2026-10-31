#!/usr/bin/env node
/* global process */

const message =
  'Real-service acceptance is retired on this local-only branch. PLAN-v4 §8b removes this lane; use the fixture-only acceptance suite.';
process.stderr.write(`${message}\n`);
process.exitCode = 2;
