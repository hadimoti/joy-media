import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 1;
const MANIFEST_KEYS = ['schemaVersion', 'candidateSha', 'lockfileSha256', 'files'];

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertRegularFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`${label} is missing: ${path}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file: ${path}`);
  return stat;
}

function collectFiles(distDir) {
  const root = resolve(distDir);
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    fail(`renderer dist directory is missing: ${root}`);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail(`renderer dist path must be a real directory: ${root}`);
  }

  const files = [];
  const visit = (directory, relativeDirectory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolutePath = join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink())
        fail(`renderer dist cannot contain symbolic links: ${relativePath}`);
      if (stat.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) fail(`renderer dist contains a non-file entry: ${relativePath}`);
      const bytes = readFileSync(absolutePath);
      files.push({
        path: relativePath.split(sep).join('/'),
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
      });
    }
  };

  visit(root, '');
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (!files.some((file) => file.path === 'index.html' && file.sizeBytes > 0)) {
    fail('renderer dist must contain a non-empty index.html');
  }
  return { root, files };
}

function assertManifestOutsideDist(distRoot, manifestPath) {
  const manifestAbsolutePath = resolve(manifestPath);
  const relativePath = relative(distRoot, manifestAbsolutePath);
  const insideDist =
    relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
  if (insideDist) fail('manifest must be stored outside the renderer dist directory');
  return manifestAbsolutePath;
}

function createManifest({ candidateSha, lockfilePath, distDir }) {
  if (!/^[0-9a-f]{40}$/u.test(candidateSha ?? ''))
    fail('candidate SHA must be a full lowercase commit SHA');
  assertRegularFile(lockfilePath, 'pnpm lockfile');
  const lockfileBytes = readFileSync(lockfilePath);
  const { root, files } = collectFiles(distDir);
  return {
    schemaVersion: SCHEMA_VERSION,
    candidateSha,
    lockfileSha256: sha256(lockfileBytes),
    files,
    root,
  };
}

function canonicalManifest({ candidateSha, lockfilePath, distDir }) {
  const created = createManifest({ candidateSha, lockfilePath, distDir });
  const { root: _root, ...manifest } = created;
  return manifest;
}

export function writeEditorWebArtifactManifest({
  candidateSha,
  lockfilePath,
  distDir,
  manifestPath,
}) {
  const { root } = collectFiles(distDir);
  const outputPath = assertManifestOutsideDist(root, manifestPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  const manifest = canonicalManifest({ candidateSha, lockfilePath, distDir });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return manifest;
}

export function verifyEditorWebArtifactManifest({
  candidateSha,
  lockfilePath,
  distDir,
  manifestPath,
}) {
  const { root } = collectFiles(distDir);
  const inputPath = assertManifestOutsideDist(root, manifestPath);
  assertRegularFile(inputPath, 'renderer artifact manifest');
  let actual;
  try {
    actual = JSON.parse(readFileSync(inputPath, 'utf8'));
  } catch {
    fail('renderer artifact manifest is not valid JSON');
  }
  const expected = canonicalManifest({ candidateSha, lockfilePath, distDir });
  if (
    !actual ||
    typeof actual !== 'object' ||
    Array.isArray(actual) ||
    JSON.stringify(Object.keys(actual)) !== JSON.stringify(MANIFEST_KEYS) ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    fail(
      'renderer artifact manifest does not match the candidate SHA, lockfile, and complete dist tree',
    );
  }
  return expected;
}

function parseOptions(args) {
  const values = new Map();
  const allowedNames = new Set(['--candidate-sha', '--lockfile', '--dist', '--manifest']);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowedNames.has(name) || value === undefined || values.has(name)) {
      fail(`invalid or duplicate command argument: ${String(name)}`);
    }
    values.set(name, value);
  }
  for (const name of ['--candidate-sha', '--lockfile', '--dist', '--manifest']) {
    if (!values.has(name)) fail(`required command argument is missing: ${name}`);
  }
  return {
    candidateSha: values.get('--candidate-sha'),
    lockfilePath: values.get('--lockfile'),
    distDir: values.get('--dist'),
    manifestPath: values.get('--manifest'),
  };
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode !== 'create' && mode !== 'verify') {
    fail(
      'usage: editor-web-artifact.mjs <create|verify> --candidate-sha <sha> --lockfile <path> --dist <path> --manifest <path>',
    );
  }
  const options = parseOptions(args);
  const manifest =
    mode === 'create'
      ? writeEditorWebArtifactManifest(options)
      : verifyEditorWebArtifactManifest(options);
  process.stdout.write(
    `${mode === 'create' ? 'created' : 'verified'} editor web artifact manifest for ${manifest.candidateSha}: ${manifest.files.length} files\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
