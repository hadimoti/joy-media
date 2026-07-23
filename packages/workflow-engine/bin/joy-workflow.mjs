#!/usr/bin/env node
/* global console, process */
/**
 * Headless workflow CLI wrapper (§7.4). All logic lives in the pure
 * `parseWorkflowJson` / `runWorkflowHeadless` / dashboard functions; this file
 * only does file/process I/O.
 *
 *   joy-workflow validate <workflow.json>
 *   joy-workflow run <workflow.json> --inputs <inputs.json> --out <dir>
 *       [--resume <checkpoint.json>] [--human-inputs <responses.json>]
 *       [--run-id <id>] [--project-revision <rev>] [--reuse-nondeterministic]
 *   joy-workflow dashboard <dashboard.json>
 *
 * `run` executes against the built-in node library without ports: port-backed
 * node types fail with coded, honest capability errors (§45.2); wiring real
 * ports arrives with the first-party workflows (WP-07.4). It writes
 * checkpoint.json, dashboard.json, and outputs.json into --out and prints the
 * dashboard text view.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildNodeLibrary,
  parseWorkflowJson,
  renderRunDashboardText,
  runWorkflowHeadless,
} from '../dist/index.js';

function usage() {
  console.error('usage: joy-workflow validate <workflow.json>');
  console.error(
    '       joy-workflow run <workflow.json> --inputs <inputs.json> --out <dir> ' +
      '[--resume <checkpoint.json>] [--human-inputs <responses.json>] ' +
      '[--run-id <id>] [--project-revision <rev>] [--reuse-nondeterministic]',
  );
  console.error('       joy-workflow dashboard <dashboard.json>');
  process.exit(2);
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--reuse-nondeterministic') {
      flags.reuseNondeterministic = true;
    } else if (arg.startsWith('--')) {
      flags[arg.slice(2)] = args[i + 1];
      i += 1;
    } else {
      usage();
    }
  }
  return flags;
}

const [command, target, ...rest] = process.argv.slice(2);
if (command === undefined || target === undefined) {
  usage();
}

const library = buildNodeLibrary();

if (command === 'validate') {
  const report = parseWorkflowJson(readFileSync(resolve(target), 'utf8'), {
    registry: library.registry,
  });
  console.log(JSON.stringify(report.ok ? { ok: true, order: report.order } : report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

if (command === 'dashboard') {
  console.log(renderRunDashboardText(readJsonFile(target)));
  process.exit(0);
}

if (command !== 'run') {
  usage();
}

const flags = parseFlags(rest);
if (flags.inputs === undefined || flags.out === undefined) {
  usage();
}

const outDir = resolve(flags.out);
const result = runWorkflowHeadless({
  workflowJson: readFileSync(resolve(target), 'utf8'),
  inputs: readJsonFile(flags.inputs),
  handlers: library.handlers,
  registry: library.registry,
  runId: flags['run-id'] ?? `run-${Date.now().toString(36)}`,
  projectRevision: flags['project-revision'] ?? 'rev-0',
  ...(flags.resume === undefined
    ? {}
    : { resumeFromJson: readFileSync(resolve(flags.resume), 'utf8') }),
  ...(flags['human-inputs'] === undefined
    ? {}
    : { humanInputs: readJsonFile(flags['human-inputs']) }),
  ...(flags.reuseNondeterministic === undefined
    ? {}
    : { reuseNondeterministic: flags.reuseNondeterministic }),
});

if (!result.ok) {
  console.error(JSON.stringify({ ok: false, issues: result.issues }, null, 2));
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'checkpoint.json'), `${JSON.stringify(result.checkpoint, null, 2)}\n`);
writeFileSync(join(outDir, 'dashboard.json'), `${JSON.stringify(result.dashboard, null, 2)}\n`);
writeFileSync(
  join(outDir, 'outputs.json'),
  `${JSON.stringify({ outputs: result.outputs, outputIssues: result.outputIssues }, null, 2)}\n`,
);
console.log(renderRunDashboardText(result.dashboard));
process.exit(result.state === 'succeeded' ? 0 : result.state === 'waiting_for_input' ? 3 : 1);
