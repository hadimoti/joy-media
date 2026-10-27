/* global process */
// Replays one v3 run from its retained evidence: the readiness build, the run inputs, the run summary and the v2/v3 comparison.
// It starts no CI run and changes no workflow. The layout it reads is the durable store copied locally (docs/release/RELEASE-RULES.md):
// <store>/<candidate-sha>/<run>-1-pgate, <store>/<candidate-sha>/<run>-1-p1, <store>/<candidate-sha>/<run>-1-release-artifacts and
// <store>/p3/<candidate-sha>/<run>-1-p1. Two values change on every replay by design, and the readiness comparison ignores them:
// the build time (endUtc), and the restore time inside the single-pass manifest, whose hash is in redactedHashes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareShadowRuns } from './ci-v3-shadow-compare.mjs';

const MANIFEST_KEY = 'test-output/readiness/single-pass-evidence/manifest.json';
const NEEDS_PREFIX = 'NEEDS_JSON: ';
const STAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/u;

/** Rebuilds the workflow's `needs` context from the NEEDS_JSON block that the gate step printed into its log. */
export function extractNeedsFromLog(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.includes(`${NEEDS_PREFIX}{`));
  if (start < 0) throw new Error('the log has no NEEDS_JSON block');
  const netBraces = (value) => [...value].reduce((sum, ch) => sum + (ch === '{') - (ch === '}'), 0);
  let body = lines[start].slice(lines[start].indexOf(NEEDS_PREFIX) + NEEDS_PREFIX.length);
  let open = netBraces(body);
  for (let index = start + 1; open > 0 && index < lines.length; index += 1) {
    const line = lines[index].replace(STAMP, '');
    body += `\n${line}`;
    open += netBraces(line);
  }
  return JSON.parse(body);
}

/** The readiness record without the two values that change on every replay. */
export function comparableReadiness(record) {
  const copy = structuredClone(record);
  delete copy.endUtc;
  if (copy.redactedHashes !== undefined) delete copy.redactedHashes[MANIFEST_KEY];
  return copy;
}

/** A canonical JSON text with sorted keys, so two records compare by content and not by key order. */
export function canonicalJson(value) {
  return JSON.stringify(value, (_, item) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/** The top-level keys whose content differs between two records. */
export function differingKeys(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => canonicalJson(a[key]) !== canonicalJson(b[key]))
    .sort();
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function commandOutput(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0)
    throw new Error(
      `${args.join(' ')} exited ${result.status}: ${`${result.stderr}${result.stdout}`.trim().slice(-500)}`,
    );
  return result.stdout;
}

/** Replays one run. Returns the report; throws, naming the step, when a step cannot run. */
export function replayRun({
  store,
  candidateSha,
  runId,
  needs,
  candidateTree,
  workflowTree,
  v2Summary,
  outDir,
  laneReports = [],
}) {
  const pgate = join(store, candidateSha, `${runId}-1-pgate`);
  const retained = join(pgate, 'v3-receipts');
  const node = process.execPath;
  const evidence1 = needs['windows-candidate']?.outputs?.evidence1;
  if (typeof evidence1 !== 'string') throw new Error('the needs context has no Windows evidence');
  mkdirSync(outDir, { recursive: true });
  const needsPath = join(outDir, 'needs.json');
  writeFileSync(needsPath, `${JSON.stringify(needs, null, 2)}\n`);

  // 1. Readiness, in the gate's own order: an empty workspace, the single-pass evidence restored, the release bytes placed, the
  //    hosted-verify report placed and checked against its digest, then the readiness builder.
  rmSync(join(candidateTree, 'test-output'), { recursive: true, force: true });
  mkdirSync(join(candidateTree, 'test-output', 'hosted-verify'), { recursive: true });
  commandOutput(
    node,
    ['ops/self-hosted/linux-runner/restore-retained-evidence.mjs', store, candidateSha, runId, '1'],
    {
      cwd: candidateTree,
      env: { ...process.env, EVIDENCE_TOPOLOGY: 'single-pass', WINDOWS_EVIDENCE_1_B64: evidence1 },
    },
  );
  commandOutput(
    node,
    [
      'tooling/release/src/retain-release-artifacts.mjs',
      '-',
      candidateSha,
      runId,
      '1',
      store,
      '--restore-to',
      'test-output/readiness/artifacts',
    ],
    { cwd: candidateTree },
  );
  const hostedPath = join(candidateTree, 'test-output', 'hosted-verify', 'report.json');
  copyFileSync(join(retained, 'hosted-verify-report.json'), hostedPath);
  if (sha256(hostedPath) !== needs['hosted-verify']?.outputs?.report_sha256)
    throw new Error(
      'the retained hosted-verify report does not match the digest in the needs context',
    );
  commandOutput(
    node,
    ['--experimental-strip-types', 'tooling/release/src/create-readiness-evidence.mjs'],
    {
      cwd: candidateTree,
      env: {
        ...process.env,
        READINESS_TOPOLOGY: 'single-pass',
        NEEDS_JSON: JSON.stringify(needs),
        CANDIDATE_SHA: candidateSha,
        GITHUB_RUN_ID: runId,
        GITHUB_RUN_ATTEMPT: '1',
      },
    },
  );
  const built = JSON.parse(
    readFileSync(join(candidateTree, 'test-output/readiness/evidence.json'), 'utf8'),
  );
  const retainedReadiness = JSON.parse(
    readFileSync(join(retained, 'readiness-evidence.json'), 'utf8'),
  );
  const readinessDiffers = differingKeys(
    comparableReadiness(built),
    comparableReadiness(retainedReadiness),
  );

  // 2. Run inputs and the run summary, from the run's own workflow commit, with the gate report from the retained gate folder.
  const inputs = join(outDir, 'run-inputs.json');
  const summaryPath = join(outDir, 'run-summary.json');
  const laneArgs = laneReports.flatMap((path) => ['--lane-vitest', path]);
  commandOutput(
    node,
    [
      join(workflowTree, 'tooling/release/src/ci-v3-run-inputs.mjs'),
      '--topology',
      'single-pass',
      '--needs',
      needsPath,
      '--gate',
      join(pgate, 'test-output/release-gate/report.json'),
      '--readiness',
      join(candidateTree, 'test-output/readiness/evidence.json'),
      '--windows',
      join(
        candidateTree,
        'test-output/readiness/single-pass-evidence/windows/pass-1/acceptance.json',
      ),
      '--hosted',
      hostedPath,
      ...laneArgs,
      '--candidate-sha',
      candidateSha,
      '--run-attempt',
      '1',
      '--out',
      inputs,
    ],
    { cwd: workflowTree },
  );
  commandOutput(
    node,
    [
      join(workflowTree, 'tooling/release/src/ci-v3-run-summary.mjs'),
      '--input',
      inputs,
      '--out',
      summaryPath,
    ],
    {
      cwd: workflowTree,
    },
  );
  const summaryBytes = readFileSync(summaryPath);
  const summaryMatchesRetained = summaryBytes.equals(
    readFileSync(join(retained, 'run-summary.json')),
  );

  // 3. The v2/v3 comparison, with the current comparison tool.
  const asSummary = (run) => ({
    ...run,
    vitest: {
      executed: new Set(run.vitest?.executed ?? []),
      failed: new Set(run.vitest?.failed ?? []),
    },
  });
  const v2 = JSON.parse(readFileSync(v2Summary, 'utf8'));
  const v3 = JSON.parse(summaryBytes.toString('utf8'));
  const comparison = compareShadowRuns(asSummary(v2), asSummary(v3));

  return {
    readiness: { matchesRetained: readinessDiffers.length === 0, differingKeys: readinessDiffers },
    summary: {
      byteIdenticalToRetained: summaryMatchesRetained,
      executed: v3.vitest.executed.length,
    },
    comparison,
  };
}

function parseArgs(argv) {
  const options = { lanes: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new Error(`Expected --name value pairs, got: ${key}`);
    if (key === '--lane-vitest') options.lanes.push(value);
    else options[key.slice(2)] = value;
  }
  for (const name of [
    'store',
    'candidate-sha',
    'run',
    'candidate-tree',
    'workflow-tree',
    'v2',
    'out-dir',
  ]) {
    if (!options[name]) throw new Error(`Missing --${name}`);
  }
  if (!options.needs && !options['gate-log']) throw new Error('Missing --needs or --gate-log');
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const report = replayRun({
    store: resolve(options.store),
    candidateSha: options['candidate-sha'],
    runId: options.run,
    needs: options['gate-log']
      ? extractNeedsFromLog(readFileSync(resolve(options['gate-log']), 'utf8'))
      : JSON.parse(readFileSync(resolve(options.needs), 'utf8')),
    candidateTree: resolve(options['candidate-tree']),
    workflowTree: resolve(options['workflow-tree']),
    v2Summary: resolve(options.v2),
    outDir: resolve(options['out-dir']),
    laneReports: options.lanes.map((path) => resolve(path)),
  });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(join(resolve(options['out-dir']), 'replay-report.json'), text);
  process.stdout.write(text);
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
