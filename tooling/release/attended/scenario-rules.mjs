// Rules shared by the attended preflight and the scenario runner. Paths are compared as real paths, so
// a junction, a symbolic link or an 8.3 short name cannot place a run inside an owner folder.

import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { FRESH_PROCESS_SCENARIO } from '../src/attended-fresh-process.ts';

/**
 * The real path of a path, with links and short names resolved. A path that does not exist yet is
 * resolved through its nearest existing parent, and the missing part is appended unchanged.
 */
export function realPathOf(path) {
  let current = resolve(path);
  const missing = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(current.slice(parent.length).replace(/^[\\/]+/u, ''));
    current = parent;
  }
  const base = existsSync(current) ? realpathSync.native(current) : current;
  return missing.length === 0 ? base : join(base, ...missing);
}

function comparable(path) {
  return realPathOf(path)
    .replace(/[\\/]+$/u, '')
    .toLowerCase();
}

/** True when two paths name the same real location. Case is ignored, as Windows ignores it. */
export function samePath(a, b) {
  return comparable(a) === comparable(b);
}

/** True when the child path is the parent folder or lies inside it, comparing real paths. */
export function isInside(child, parent) {
  const c = comparable(child);
  const p = comparable(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`);
}

/** The files a finished run leaves in its folder. A launch must not reuse a folder that holds any of them. */
const FINISHED_RUN_ARTIFACTS = [
  'run.json',
  'receipt.json',
  'error.json',
  'profile-source',
  'profile-fresh',
];

/**
 * The finished-run files and profile folders that already exist in a run folder. A dry run leaves only
 * its preflight files, so a launch may follow one in the same folder; a list that is not empty is a refusal.
 */
export function finishedRunArtifacts(outDir) {
  return FINISHED_RUN_ARTIFACTS.filter((name) => existsSync(join(outDir, name)));
}

/** The options a scenario run takes. Each name is required, as --name value. */
export const RUN_OPTION_NAMES = [
  'scenario',
  'exe',
  'candidate',
  'expected-exe-sha256',
  'profile-source',
  'profile',
  'library',
  'out',
  'project',
];

/** The options the fresh-process scenario takes. It creates both of its profiles inside the run folder. */
export const FRESH_PROCESS_OPTION_NAMES = [
  'scenario',
  'exe',
  'candidate',
  'expected-exe-sha256',
  'library',
  'out',
];

/**
 * Parses the runner's arguments. `--launch` is the only switch that starts the app, so it is a flag
 * with no value. Throws with the first problem found.
 */
export function parseRunArgs(argv, scenarios) {
  const options = { launch: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--launch') {
      options.launch = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
    options[arg.slice(2)] = value;
    index += 1;
  }
  const required =
    options.scenario === FRESH_PROCESS_SCENARIO ? FRESH_PROCESS_OPTION_NAMES : RUN_OPTION_NAMES;
  for (const name of required) {
    if (typeof options[name] !== 'string' || options[name] === '') {
      throw new Error(`--${name} is required`);
    }
  }
  if (!scenarios.includes(options.scenario))
    throw new Error(`unknown scenario: ${options.scenario}`);
  if (!/^[0-9a-f]{40}$/u.test(options.candidate)) {
    throw new Error('--candidate must be the full 40-character lowercase commit');
  }
  if (!/^[0-9a-f]{64}$/u.test(options['expected-exe-sha256'])) {
    throw new Error(
      '--expected-exe-sha256 must be the 64-character lowercase SHA-256 of the build',
    );
  }
  return options;
}
