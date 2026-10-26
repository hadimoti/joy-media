// Lists, and with --apply removes, old evidence runs from a durable evidence store (plan §3.4, decision D20).
//
//   node prune-evidence.mjs <evidence-root> [--older-than-days 30] [--released <file>] [--now <ISO time>] [--apply]
//
// The store layout is the one retain-release-artifacts.mjs writes: <root>/<candidate-sha>/<run>-<attempt>-release-artifacts/.
// A run is the unit of pruning. The script is dry-run unless --apply is given, and it never runs in a workflow: the gate
// does not delete, and a policy test fails any workflow that names this file.
//
// Rules, all fail-closed:
// - The root must hold the marker file JOY_EVIDENCE_STORE, which the owner creates once. Without it nothing is read or deleted.
// - The root must sit outside this checkout and outside any runner workspace (the same rule as retain-release-artifacts.mjs).
// - Symbolic links anywhere under the root refuse the whole run. Nothing is followed and nothing is deleted.
// - --released names a file with one full candidate SHA per line. Every run of a released candidate is kept forever.
// - A run is a prune candidate only when its newest file is older than the cutoff (default 30 days).
// - Top-level files in the root, including the marker, are never touched.
import { lstatSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = 'JOY_EVIDENCE_STORE';
const SHA = /^[0-9a-f]{40}$/u;
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(message) {
  throw new Error(message);
}

function within(anchor, target) {
  const rel = relative(anchor, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Refuses a root that is inside this checkout or a runner workspace. */
export function assertStoreLocation(root, env = process.env) {
  const target = resolve(root);
  const checkout = fileURLToPath(new URL('../../../', import.meta.url));
  const workspace = env.RUNNER_WORKSPACE ?? '';
  if (
    within(resolve(checkout), target) ||
    (workspace !== '' && within(resolve(workspace), target))
  ) {
    fail('the evidence root must be outside the checkout and the runner workspace');
  }
}

/** Parses the released-candidate list: one full lowercase SHA per line, blank lines allowed. */
export function parseReleased(text) {
  const shas = new Set();
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (line === '') continue;
    if (!SHA.test(line)) fail(`released list line ${index + 1} is not a full lowercase commit SHA`);
    shas.add(line);
  }
  return shas;
}

/** Walks a tree and returns its newest file time, refusing any symbolic link on the way. */
export function newestFileTime(dir) {
  let newest = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) fail(`refusing to prune past a symbolic link: ${path}`);
    if (info.isDirectory()) newest = Math.max(newest, newestFileTime(path));
    else if (info.isFile()) newest = Math.max(newest, info.mtimeMs);
    else fail(`refusing to prune an unexpected entry: ${path}`);
  }
  return newest;
}

function directoryBytes(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = lstatSync(path);
    total += info.isDirectory() ? directoryBytes(path) : info.size;
  }
  return total;
}

/** Plans the prune: returns the runs to keep and the runs that are old enough to remove. */
export function planPrune(
  root,
  { olderThanDays = 30, released = new Set(), now = Date.now() } = {},
) {
  const cutoff = now - olderThanDays * DAY_MS;
  const kept = [];
  const candidates = [];
  for (const candidate of readdirSync(root).sort()) {
    const candidatePath = join(root, candidate);
    const info = lstatSync(candidatePath);
    if (info.isSymbolicLink()) fail(`refusing to prune past a symbolic link: ${candidatePath}`);
    if (!info.isDirectory()) continue;
    for (const run of readdirSync(candidatePath).sort()) {
      const runPath = join(candidatePath, run);
      const runInfo = lstatSync(runPath);
      if (runInfo.isSymbolicLink()) fail(`refusing to prune past a symbolic link: ${runPath}`);
      if (!runInfo.isDirectory()) continue;
      const unit = { candidate, run, path: runPath, newest: newestFileTime(runPath) };
      if (released.has(candidate) || unit.newest >= cutoff) kept.push(unit);
      else candidates.push({ ...unit, bytes: directoryBytes(runPath) });
    }
  }
  return { cutoff, kept, candidates };
}

/** Runs the tool. Returns the report and the exit code; --apply is the only way a run is deleted. */
export function run(argv, env = process.env, { now = Date.now() } = {}) {
  const options = { olderThanDays: 30, released: new Set(), apply: false, now };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--older-than-days') {
      const value = Number(argv[(index += 1)]);
      if (!Number.isInteger(value) || value < 1)
        fail('--older-than-days must be a whole number of days, at least 1');
      options.olderThanDays = value;
    } else if (arg === '--released') {
      const file = argv[(index += 1)];
      if (file === undefined) fail('--released needs a file');
      options.released = parseReleased(readFileSync(file, 'utf8'));
    } else if (arg === '--now') {
      const value = Date.parse(argv[(index += 1)] ?? '');
      if (Number.isNaN(value)) fail('--now needs an ISO time');
      options.now = value;
    } else if (arg.startsWith('--')) fail(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1) fail('usage: prune-evidence.mjs <evidence-root> [options]');

  const root = resolve(positional[0]);
  assertStoreLocation(root, env);
  if (!statSync(root).isDirectory()) fail('the evidence root is not a directory');
  if (lstatSync(root).isSymbolicLink()) fail('the evidence root must not be a symbolic link');
  if (!lstatSync(join(root, MARKER), { throwIfNoEntry: false })?.isFile()) {
    fail(`the evidence root has no ${MARKER} marker; nothing was read or removed`);
  }

  const plan = planPrune(root, options);
  const pruned = [];
  if (options.apply) {
    for (const unit of plan.candidates) {
      if (!within(root, unit.path))
        fail(`refusing to remove a path outside the store: ${unit.path}`);
      rmSync(unit.path, { recursive: true, force: false });
      pruned.push(`${unit.candidate}/${unit.run}`);
    }
  }
  const report = {
    mode: options.apply ? 'apply' : 'dry-run',
    cutoff: new Date(plan.cutoff).toISOString(),
    keptRuns: plan.kept.length,
    releasedCandidates: options.released.size,
    wouldPrune: plan.candidates.map((unit) => `${unit.candidate}/${unit.run}`),
    bytes: plan.candidates.reduce((total, unit) => total + unit.bytes, 0),
    pruned,
  };
  return { report, exitCode: 0 };
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    const { report, exitCode } = run(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
