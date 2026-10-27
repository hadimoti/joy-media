// Builds the unsigned release manifest that the desktop app and `joy-media update verify` check (packages/release-trust).
//
//   node build-release-manifest.mjs --release-dir <folder> --version <semver> --channel stable|beta --issued-at <UTC time>
//     --file <name> [--file <name>]... [--min-supported <semver>] --out <file>
//
// The manifest lists the files a user can download, each with its size and SHA-256, and nothing else. Its schema is strict,
// as packages/release-trust/src/manifest.ts is: the keys channel, version, issuedAt, minSupportedVersion and files, and no
// other. The packager's joy-media-release-manifest.json is a different document and is not this one.
//
// The owner signs the exact bytes of the output with sign-release-manifest.mjs (docs/release/owner-checklists/signing-d2.md).
// This tool never signs, never reaches the network and never overwrites its output. The issue time is an argument, so the
// same inputs always give the same bytes.
import { createHash } from 'node:crypto';
import { createReadStream, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CHANNELS = new Set(['stable', 'beta']);
const MAX_FILES = 256;
const MAX_FILE_BYTES = 4 * 1024 ** 3;
const OPTIONS = new Set([
  '--release-dir',
  '--version',
  '--channel',
  '--issued-at',
  '--min-supported',
  '--file',
  '--out',
]);

/** A bad argument or a bad input. The command prints the message and exits 2 without writing anything. */
export class UsageError extends Error {}

/** Reads `--name value` pairs. `--file` may repeat; every other option may appear once. */
export function parseArgs(argv) {
  const options = { files: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!OPTIONS.has(name)) throw new UsageError(`unknown option: ${name}`);
    if (value === undefined || value.startsWith('--'))
      throw new UsageError(`${name} needs a value`);
    if (name === '--file') {
      options.files.push(value);
      continue;
    }
    const key = name.slice(2);
    if (options[key] !== undefined) throw new UsageError(`${name} is given twice`);
    options[key] = value;
  }
  return options;
}

/** Checks every option and returns the values the build uses. Nothing is read from disk here. */
export function validateOptions(options) {
  for (const key of ['release-dir', 'version', 'channel', 'issued-at', 'out']) {
    if (options[key] === undefined) throw new UsageError(`--${key} is required`);
  }
  if (!SEMVER.test(options.version)) throw new UsageError('--version must be a semantic version');
  if (!CHANNELS.has(options.channel)) throw new UsageError('--channel must be stable or beta');
  if (!ISO_UTC.test(options['issued-at']) || Number.isNaN(Date.parse(options['issued-at']))) {
    throw new UsageError('--issued-at must be a UTC time such as 2026-10-28T12:00:00Z');
  }
  if (options['min-supported'] !== undefined && !SEMVER.test(options['min-supported'])) {
    throw new UsageError('--min-supported must be a semantic version');
  }
  if (options.files.length === 0) throw new UsageError('at least one --file is required');
  if (options.files.length > MAX_FILES) throw new UsageError(`at most ${MAX_FILES} files`);
  const seen = new Set();
  for (const name of options.files) {
    if (!FILE_NAME.test(name)) throw new UsageError(`${name} is not a plain file name`);
    if (seen.has(name)) throw new UsageError(`${name} is listed twice`);
    seen.add(name);
  }
  return {
    releaseDir: resolve(options['release-dir']),
    version: options.version,
    channel: options.channel,
    issuedAt: options['issued-at'],
    minSupportedVersion: options['min-supported'],
    files: [...options.files].sort(),
    out: resolve(options.out),
  };
}

/** Streams a file once and returns its exact size and SHA-256. */
export function measureFile(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    let size = 0;
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolvePromise({ size, sha256: hash.digest('hex') }));
  });
}

/** Returns the manifest text for the validated options. Files are listed by name, so the argument order does not matter. */
export async function buildManifestText(options) {
  const entries = [];
  for (const name of options.files) {
    const path = join(options.releaseDir, name);
    if (!statSync(path).isFile())
      throw new UsageError(`${name} is not a file in the release folder`);
    const { size, sha256 } = await measureFile(path);
    if (size <= 0 || size > MAX_FILE_BYTES)
      throw new UsageError(`${name} has a size the manifest refuses`);
    entries.push({ name, size, sha256 });
  }
  const manifest = {
    channel: options.channel,
    version: options.version,
    issuedAt: options.issuedAt,
    ...(options.minSupportedVersion === undefined
      ? {}
      : { minSupportedVersion: options.minSupportedVersion }),
    files: entries,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Runs the command. Returns the exit code; the report goes to stdout and every error to stderr. */
export async function main(argv) {
  let options;
  try {
    options = validateOptions(parseArgs(argv));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  let text;
  try {
    text = await buildManifestText(options);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    if (error?.code === 'ENOENT') {
      process.stderr.write('a listed file is missing from the release folder\n');
      return 2;
    }
    throw error;
  }
  try {
    writeFileSync(options.out, text, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    process.stderr.write(
      error?.code === 'EEXIST'
        ? 'the output file already exists; refusing to overwrite it\n'
        : `the manifest could not be written: ${error.message}\n`,
    );
    return 2;
  }
  const bytes = Buffer.from(text, 'utf8');
  process.stdout.write(
    `${JSON.stringify(
      {
        manifest: options.out,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        files: options.files,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
