// Retains the Windows release artifacts of one candidate in the designated durable evidence store, and
// verifies a retained copy. The Windows lane runs the retain mode under PowerShell, and the Linux gate
// runs the verify mode, so this one implementation holds the contract for both.
//
//   node retain-release-artifacts.mjs <staged-dir> <candidate-sha> <run-id> <attempt> <evidence-root>
//   node retain-release-artifacts.mjs - <candidate-sha> <run-id> <attempt> <evidence-root> --verify-only
//
// Retain mode: <staged-dir> holds artifact-manifest.json and exactly the files that manifest lists.
// Every file is hashed here, not by the lane that wrote the manifest, and compared with the manifest.
// Where SHA256SUMS.txt names a file, its digest must agree too. A mismatch, a missing or extra file, a
// symlink, or an identity that does not match this run throws and writes nothing. The copy is written
// once, under the candidate and run, and it is verified against the same manifest before the call
// returns.
//
// Verify mode: the retained copy must already exist. The same checks run against the bytes in the store,
// and nothing is written.
//
// Files are copied byte for byte. Release binaries never pass through the redaction that the JSON and
// text evidence uses, because redaction rewrites bytes.
import { createHash } from 'node:crypto';
import {
  createReadStream,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  accessSync,
  constants,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST = 'artifact-manifest.json';
const SUMS = 'SHA256SUMS.txt';
const FORMAT = 'joy-media-release-artifacts';

export function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', rejectHash);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

// The manifest's identity and its file list. Paths must stay inside the artifact directory.
export function parseManifest(manifest, { candidate, runId, attempt }) {
  if (manifest.format !== FORMAT) throw new Error('unexpected manifest format');
  if (manifest.candidateSha !== candidate)
    throw new Error('manifest candidateSha does not match the candidate');
  if (String(manifest.runId) !== runId || String(manifest.attempt) !== attempt) {
    throw new Error('manifest run identity does not match this run');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0)
    throw new Error('manifest lists no files');
  const seen = new Set();
  for (const entry of manifest.files) {
    const path = String(entry.path);
    if (
      path.startsWith('/') ||
      path.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
      throw new Error(`manifest path is not a plain relative path: ${path}`);
    }
    if (
      !/^[0-9a-f]{64}$/u.test(String(entry.sha256)) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0
    ) {
      throw new Error(`manifest entry is malformed: ${path}`);
    }
    if (seen.has(path)) throw new Error(`manifest lists ${path} twice`);
    seen.add(path);
  }
  // The checksum file is the independent record of every other file. A set that does not list it cannot be
  // checked against it, so the manifest must list it.
  if (!seen.has(SUMS)) throw new Error(`manifest does not list ${SUMS}`);
  return manifest.files;
}

// Every file under dir, as a posix relative path. A symlink, FIFO, socket or device anywhere in the
// tree throws.
export function listFiles(dir) {
  const found = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) throw new Error(`symlinks are not allowed in ${dir}`);
      if (info.isDirectory()) walk(full);
      else if (info.isFile()) found.push(relative(dir, full).split(sep).join('/'));
      else
        throw new Error(`refusing to list ${full}: only regular files and directories are allowed`);
    }
  };
  walk(dir);
  return found.filter((path) => path !== MANIFEST).sort();
}

// The directory holds exactly the manifest's files, each with the manifest's size and digest, and
// SHA256SUMS.txt agrees with every file it names. Digests are computed here, from the bytes.
export async function verifyTree(dir, entries) {
  const expectedPaths = entries.map((entry) => entry.path).sort();
  const actualPaths = listFiles(dir);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`${dir} does not hold exactly the manifest's files`);
  }
  const digests = new Map();
  for (const entry of entries) {
    const full = join(dir, ...entry.path.split('/'));
    if (statSync(full).size !== entry.bytes)
      throw new Error(`byte count mismatch for ${entry.path} in ${dir}`);
    const digest = await sha256File(full);
    if (digest !== entry.sha256) throw new Error(`sha256 mismatch for ${entry.path} in ${dir}`);
    digests.set(entry.path, digest);
  }
  const sumsPath = join(dir, SUMS);
  if (existsSync(sumsPath)) {
    for (const line of readFileSync(sumsPath, 'utf8').split('\n')) {
      const text = line.replace(/\r$/u, '');
      if (text.trim() === '') continue;
      const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/u.exec(text);
      if (!match) throw new Error(`SHA256SUMS.txt has a line that is not a checksum: ${text}`);
      const [, sum, name] = match;
      if (!digests.has(name))
        throw new Error(`SHA256SUMS.txt names ${name}, which is not in ${dir}`);
      if (digests.get(name) !== sum.toLowerCase())
        throw new Error(`SHA256SUMS.txt disagrees with ${name}`);
    }
  }
}

// The evidence root must sit outside the checkout, _work and _temp, as the gate's other stores do. The
// comparison works on whole path segments and folds case on Windows: a sibling folder that only shares a
// name prefix with the checkout is accepted, and the same checkout spelled in another case is refused.
function assertStoreLocation(root, env) {
  // The Win32 layer ignores letter case and strips trailing dots and spaces from each name, so `_work.` is
  // `_work`. Both are normalized away on Windows before any comparison.
  const normalize = (path) =>
    resolve(path)
      .split(sep)
      .map((segment) =>
        process.platform === 'win32' ? segment.toLowerCase().replace(/[. ]+$/u, '') : segment,
      )
      .join(sep);
  const target = normalize(root);
  const within = (anchor) => {
    const rel = relative(normalize(anchor), target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  const workspace = env.RUNNER_WORKSPACE ?? '';
  const segments = target.split(sep);
  if (
    (workspace !== '' && within(workspace)) ||
    segments.includes('_work') ||
    segments.includes('_temp')
  ) {
    throw new Error('the evidence root must be outside the checkout, _work and _temp');
  }
}

// Flushes one file to stable storage before the retention is reported. Windows needs a writable handle for
// FlushFileBuffers. The copy has just created the file, so opening it for writing changes nothing in it.
export function syncFile(path) {
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Flushes a directory entry on POSIX. Windows cannot open a directory for fsync, so there the file flushes
// are the durability step, and the directory is not flushed separately.
export function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Every copied file, the manifest, and every directory that holds one reach stable storage. Directories flush
// deepest first, after the entries they hold.
export function syncTree(dir, entries, sync = { file: syncFile, directory: syncDirectory }) {
  const directories = new Set([dir]);
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      directories.add(join(dir, ...parts.slice(0, depth)));
    }
    sync.file(join(dir, ...entry.path.split('/')));
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    sync.directory(directory);
  }
}

// Copies a staged tree into a destination that the caller created with an exclusive mkdir. Each file is
// created with COPYFILE_EXCL, so the copy can never overwrite. cpSync is not used: newer Node versions
// refuse any existing destination, even an empty one, so the write-once gate above would always fail.
// Directories take the default mode, not the source's: the manifest and SHA256SUMS.txt check file bytes.
function copyTreeExclusive(source, target) {
  for (const name of readdirSync(source)) {
    const from = join(source, name);
    const to = join(target, name);
    const info = lstatSync(from);
    if (info.isDirectory()) {
      mkdirSync(to);
      copyTreeExclusive(from, to);
    } else if (info.isFile()) {
      copyFileSync(from, to, constants.COPYFILE_EXCL);
    } else {
      throw new Error(`refusing to retain ${from}: only regular files and directories are allowed`);
    }
  }
}

export async function run(argv, env = process.env, options = {}) {
  const [stagedArg, candidate, runId, attempt, root, mode] = argv;
  if (!/^[0-9a-f]{40}$/u.test(candidate ?? ''))
    throw new Error('candidate sha must be 40 lowercase hex characters');
  if (!/^[0-9]+$/u.test(runId ?? '') || !/^[0-9]+$/u.test(attempt ?? ''))
    throw new Error('run id and attempt must be numbers');
  if (!root) throw new Error('a durable evidence root is required');
  assertStoreLocation(root, env);
  const identity = { candidate, runId, attempt };
  const dest = join(root, candidate, `${runId}-${attempt}-release-artifacts`);

  if (mode === '--verify-only') {
    if (!existsSync(dest))
      throw new Error(`no retained release artifacts for this candidate and run at ${dest}`);
    const entries = parseManifest(JSON.parse(readFileSync(join(dest, MANIFEST), 'utf8')), identity);
    await verifyTree(dest, entries);
    return `verified ${entries.length} retained file(s) at ${dest}`;
  }
  if (mode !== undefined) throw new Error(`unknown mode: ${mode}`);

  if (!existsSync(join(stagedArg, MANIFEST)))
    throw new Error(`${MANIFEST} is missing from ${stagedArg}`);
  const entries = parseManifest(
    JSON.parse(readFileSync(join(stagedArg, MANIFEST), 'utf8')),
    identity,
  );
  await verifyTree(stagedArg, entries);

  mkdirSync(root, { recursive: true });
  accessSync(root, constants.W_OK);
  mkdirSync(join(root, candidate), { recursive: true });
  // A non-recursive mkdir is the write-once gate: when two retentions race, exactly one creates this
  // run's folder and the other fails with EEXIST.
  try {
    mkdirSync(dest);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(`retention is write-once, and ${dest} already exists`);
    throw error;
  }
  try {
    copyTreeExclusive(stagedArg, dest);
    // The copy must reach stable storage before the retention is reported. The manifest is flushed too, since
    // verify mode reads it from the store.
    const sync = options.sync ?? { file: syncFile, directory: syncDirectory };
    syncTree(dest, [...entries, { path: MANIFEST }], sync);
    const retainedManifest = readFileSync(join(dest, MANIFEST));
    const stagedManifest = readFileSync(join(stagedArg, MANIFEST));
    if (!retainedManifest.equals(stagedManifest)) {
      throw new Error('retained manifest differs from the staged manifest');
    }
    sync.directory(join(root, candidate));
    sync.directory(root);
    await verifyTree(dest, entries);
  } catch (error) {
    // This call created the folder, so a failed copy or check leaves no partial retention behind. A failed
    // removal must not hide the error that made the retention fail.
    try {
      rmSync(dest, { recursive: true, force: true });
    } catch {
      // The original failure is the one to report.
    }
    throw error;
  }
  return `retained and re-verified ${entries.length} file(s) at ${dest}`;
}

const isEntry =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntry) {
  try {
    console.log(`retain-release-artifacts: ${await run(process.argv.slice(2))}`);
  } catch (error) {
    console.error(`retain-release-artifacts: ${error.message}`);
    process.exitCode = 1;
  }
}
