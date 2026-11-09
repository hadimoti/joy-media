// Rules shared by the attended preflight and the scenario runner. Paths are compared as real paths, so
// a junction, a symbolic link or an 8.3 short name cannot place a run inside an owner folder.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
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

/**
 * Every entry in a run folder. A run needs an empty folder: a dry run and a launch each use their own, so no file
 * from an earlier attempt is overwritten, appended to, or followed through a link.
 */
export function unexpectedRunArtifacts(outDir) {
  // lstat, not stat: a link or a junction at the folder itself must refuse, not read as an empty folder.
  let info;
  try {
    info = lstatSync(outDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // A missing folder is empty, unless the nearest existing folder above it is a link or a file.
      const ancestor = nearestExisting(dirname(outDir));
      const kind = ancestor === undefined ? undefined : kindOf(ancestor);
      if (kind === 'link') return ['a link (not a folder)'];
      if (kind === 'file') return ['a file (not a folder)'];
      return [];
    }
    if (error.code === 'ENOTDIR') return ['a file (not a folder)'];
    return [`a folder that cannot be read (${error.code ?? 'error'})`];
  }
  if (info.isSymbolicLink()) return ['a link (not a folder)'];
  if (!info.isDirectory()) return ['a file (not a folder)'];
  try {
    return readdirSync(outDir);
  } catch (error) {
    return [`a folder that cannot be read (${error.code ?? 'error'})`];
  }
}

/** The path itself, or the nearest folder above it that exists (links are not followed), or undefined. */
function nearestExisting(path) {
  let current = path;
  for (;;) {
    try {
      lstatSync(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

/** 'link', 'file' or 'folder' for what a path is, without following a link; undefined when it does not exist. */
function kindOf(path) {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return 'link';
    return info.isDirectory() ? 'folder' : 'file';
  } catch {
    return undefined;
  }
}

/**
 * The first link or junction inside a folder tree, found without following any link, or a folder that cannot be
 * read. Undefined when the tree is clean. A missing folder is clean.
 */
export function linkInside(folder) {
  let info;
  try {
    info = lstatSync(folder);
  } catch (error) {
    return error.code === 'ENOENT' ? undefined : folder;
  }
  if (info.isSymbolicLink()) return folder;
  // A file with more than one name is a hard link: writing it would change another file, so it refuses too.
  if (!info.isDirectory()) return info.nlink > 1 ? folder : undefined;
  let names;
  try {
    names = readdirSync(folder);
  } catch {
    return folder;
  }
  for (const name of names) {
    const found = linkInside(join(folder, name));
    if (found !== undefined) return found;
  }
  return undefined;
}

/** True when the path, or any folder above it that exists, is a link or a junction. Links are never followed. */
export function linkOnPath(path) {
  let current = resolve(path);
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      // A missing part of the path is not a link; the walk goes on upward.
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * The first problem in a run folder that would let a write leave it: a link on its path or inside it, a shared file, or an
 * unreadable folder. Undefined when the folder is clean. The preflight and the runners call it again before the writes they
 * make into the run folder, because a link can appear after an earlier check.
 */
export function runFolderProblem(folder) {
  if (linkOnPath(folder)) return `${folder} goes through a link or a junction`;
  const inside = linkInside(folder);
  if (inside !== undefined) {
    return `${inside} is a link, a junction, a shared file or an unreadable folder inside the run folder`;
  }
  return undefined;
}

/**
 * The first folder on PATH that holds the file, as an absolute path. Relative PATH entries are never searched,
 * and neither is the working folder or anything inside it, so a tool there cannot be picked up by its bare name.
 */
export function findOnPath(fileName, pathValue = process.env.PATH ?? '') {
  const working = process.cwd();
  for (const entry of pathValue.split(';')) {
    // A quoted PATH entry is read without its quotes.
    const folder = entry.replace(/^"(.*)"$/u, '$1');
    if (!isAbsolute(folder) || isInside(folder, working)) continue;
    const candidate = join(folder, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * A Windows system tool, by its full path under the system folder, so a file of the same name elsewhere is never run.
 */
export function systemTool(...parts) {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...parts);
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

/** Options that either scenario may take. */
const SHARED_OPTION_NAMES = ['port', 'owner-library-files'];

/**
 * Every option the restart scenario takes. Any other name is refused, so a typo such as
 * --owner-library-file cannot silently drop an approval.
 */
const RUN_ACCEPTED_NAMES = [...RUN_OPTION_NAMES, ...SHARED_OPTION_NAMES];

/**
 * Every option the fresh-process scenario takes. It has no source profile and no project, so those
 * are refused for it.
 */
const FRESH_ACCEPTED_NAMES = [...FRESH_PROCESS_OPTION_NAMES, ...SHARED_OPTION_NAMES, 'media'];

/**
 * Parses the runner's arguments. `--launch` is the only switch that starts the app, so it is a flag
 * with no value. Throws with the first problem found.
 */
export function parseRunArgs(argv, scenarios) {
  const options = { launch: false };
  const given = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--launch') {
      options.launch = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
    if (given.has(name)) throw new Error(`${arg} is given more than once`);
    given.add(name);
    options[name] = value;
    index += 1;
  }
  const required =
    options.scenario === FRESH_PROCESS_SCENARIO ? FRESH_PROCESS_OPTION_NAMES : RUN_OPTION_NAMES;
  for (const name of required) {
    if (typeof options[name] !== 'string' || options[name] === '') {
      throw new Error(`--${name} is required`);
    }
  }
  const accepted =
    options.scenario === FRESH_PROCESS_SCENARIO ? FRESH_ACCEPTED_NAMES : RUN_ACCEPTED_NAMES;
  for (const name of given) {
    if (!accepted.includes(name)) throw new Error(`unknown option --${name}`);
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
  const approvedFiles = options['owner-library-files'];
  if (approvedFiles !== undefined && !/^[1-9][0-9]*$/u.test(approvedFiles)) {
    throw new Error('--owner-library-files must be a whole number of files');
  }
  if (options.launch && approvedFiles === undefined) {
    throw new Error(
      '--owner-library-files is required with --launch: a launch needs the owner library count approved',
    );
  }
  return options;
}

/**
 * The number of files under a folder, counting every subfolder. A link or a junction is neither followed nor counted:
 * folderSignature records links, so a link that appears during a run still changes the run's evidence.
 */
export function countFiles(directory) {
  let total = 0;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) total += countFiles(path);
    else if (info.isFile()) total += 1;
  }
  return total;
}

/**
 * A digest of a folder: first its resolved path, so a folder swapped for a link to another folder changes it, then every
 * entry under it, sorted. A file is recorded with its path, size, modified time and link count; a folder with its path;
 * a link with its path only. A link is never followed, so what it points to is not read. A file whose status cannot be
 * read when its turn comes is recorded as gone. A folder that cannot be listed makes the read throw, so the run stops.
 * A rewrite that keeps the size and the modified time does not change the digest.
 */
export function folderSignature(folder) {
  if (!existsSync(folder)) return 'missing';
  const lines = [`root\t${realpathSync.native(folder)}`];
  const walk = (directory, prefix) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const entry = prefix === '' ? name : `${prefix}/${name}`;
      let info;
      try {
        info = lstatSync(path);
      } catch {
        lines.push(`gone\t${entry}`);
        continue;
      }
      if (info.isSymbolicLink()) {
        lines.push(`link\t${entry}`);
      } else if (info.isDirectory()) {
        lines.push(`dir\t${entry}`);
        walk(path, entry);
      } else {
        lines.push(`file\t${entry}\t${info.size}\t${info.mtimeMs}\t${info.nlink}`);
      }
    }
  };
  walk(folder, '');
  lines.sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * The report after the run's folders are compared again. A change is a blocker: the verdict fails, the blockers keep
 * what the run found, and the report carries no receipt. run.json is still written from it. With no change, the report
 * is returned as it was.
 */
export function reportWithChanges(report, changed) {
  if (changed.length === 0) return report;
  return {
    ...report,
    verdict: 'failed',
    blockers: [...report.blockers, ...changed],
    receipt: undefined,
  };
}

/**
 * Compares each watched folder's signature with the one read before the run. A folder whose signature changed is a
 * blocker, named by its label. Each `after` is read after the run, in the order the caller lists them.
 */
export function reportWithFolderChanges(report, watched) {
  const changed = watched
    .filter((item) => item.after !== item.before)
    .map((item) => `${item.label} changed during the run`);
  return reportWithChanges(report, changed);
}

/** The owner's default asset library under a home folder. A run reads it only to count its files. */
export function ownerDefaultLibrary(home) {
  return join(home, 'joy-media-assets');
}

/** The owner library count that the run approves with --owner-library-files, or undefined when it approves none. */
export function approvedOwnerFilesOf(options) {
  const value = options['owner-library-files'];
  return value === undefined ? undefined : Number(value);
}

/**
 * The refusal for an owner library whose file count is not the count approved for this run. With no approved
 * count, nothing is refused here: the run's own guards still compare the count before, between and after.
 */
export function ownerLibraryRefusal(approved, actual) {
  if (approved === undefined || approved === actual) return null;
  return `the owner library has ${actual} files, not the ${approved} approved for this run`;
}
