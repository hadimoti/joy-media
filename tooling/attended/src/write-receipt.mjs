// Writes the receipt of one attended session (plan section 3.3) from that session's own results. It refuses to write while a
// threshold the session needs is still null in docs/qa/attended/model-thresholds.json, and it refuses an output inside this
// checkout. buildReceipt (receipt.mjs) checks the shape of the steps and refuses any leak, so a refused run writes nothing.
//
//   node tooling/attended/src/write-receipt.mjs --session G1|G2|A1 --candidate-sha <40 lowercase hex> --exe <file>
//     --thresholds <file> --started <UTC time> --finished <UTC time> --steps <file> --leak-scan <file>
//     --out <file outside this repository>
//
// The steps file is a JSON array of { "id", "result": "pass" | "fail", "measurement"?, "unit"? }. The leak-scan file is the
// output of leak-scan.mjs. Both hold results and counts only, never a credential or raw provider output.
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReceipt, serializeReceipt } from './receipt.mjs';

const CHECKOUT = fileURLToPath(new URL('../../../', import.meta.url));
const OPTIONS = [
  'session',
  'candidate-sha',
  'exe',
  'thresholds',
  'started',
  'finished',
  'steps',
  'leak-scan',
  'out',
];
// The thresholds each session needs before its receipt can be accepted. Denoise has no entry, because denoise is excluded
// from v1.0.3 (docs/product/FEATURE-STATUS.md).
const REQUIRED_THRESHOLDS = {
  G1: [],
  G2: [
    'sessions.G2.defaultLaunches',
    'sessions.G2.maxGpuProcessExits',
    'sessions.G2.maxFallbackRelaunches',
    'sessions.G2.minEncoderSessionsDuringExport',
  ],
  A1: ['upscale.ssimMarginOverBicubic'],
};
// The steps each session must list. A receipt that leaves one out is refused, so a partial session cannot be accepted.
// G1 records a diagnosis and has no pass gate, so it has no required steps.
const REQUIRED_STEPS = {
  G1: [],
  G2: ['default-launches', 'export-spec'],
  A1: [
    'sign-in',
    'restart-keeps-session',
    'entitlement-refreshed',
    'offline-boundary-visible',
    'sign-out-clears-credential',
    'token-rejected-after-sign-out',
    'upscale-quality',
  ],
};

/** A bad argument. Exit 2, nothing written. */
export class UsageError extends Error {}

/** A refused receipt: a threshold is not registered, or the output is in the repository. Exit 1, nothing written. */
export class RefusalError extends Error {}

/** Reads `--name value` pairs. Every option is required. */
export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !OPTIONS.includes(name.slice(2))) {
      throw new UsageError(`unknown option: ${name}`);
    }
    if (value === undefined || value.startsWith('--'))
      throw new UsageError(`${name} needs a value`);
    options[name.slice(2)] = value;
  }
  const missing = OPTIONS.filter((name) => options[name] === undefined);
  if (missing.length > 0) throw new UsageError(`missing --${missing.join(', --')}`);
  return options;
}

/** The value at a dotted path, or undefined when a part of the path is missing. */
export function valueAt(object, path) {
  return path
    .split('.')
    .reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), object);
}

/** The thresholds a session needs that are not registered. A null, a missing value or a non-number counts as unregistered. */
export function unregisteredThresholds(session, thresholds) {
  return (REQUIRED_THRESHOLDS[session] ?? []).filter((path) => {
    const value = valueAt(thresholds, path);
    return typeof value !== 'number' || !Number.isFinite(value);
  });
}

/** The required steps of a session that the steps list does not contain. */
export function missingSteps(session, steps) {
  return (REQUIRED_STEPS[session] ?? []).filter((id) => !steps.some((step) => step?.id === id));
}

/** True when `path` is this checkout or lies inside it. */
export function insideCheckout(path) {
  const rel = relative(CHECKOUT, resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

/** Builds and writes the receipt. Returns the receipt. Throws UsageError or RefusalError, or the error buildReceipt raises. */
export async function writeSessionReceipt(options) {
  if (!Object.hasOwn(REQUIRED_THRESHOLDS, options.session)) {
    throw new UsageError('--session must be G1, G2 or A1');
  }
  if (insideCheckout(options.out)) {
    throw new RefusalError('the receipt must be written outside this repository');
  }
  const thresholdsBytes = readFileSync(options.thresholds);
  const thresholds = JSON.parse(thresholdsBytes.toString('utf8'));
  const unregistered = unregisteredThresholds(options.session, thresholds);
  if (unregistered.length > 0) {
    throw new RefusalError(
      `no ${options.session} receipt while these thresholds are not registered: ${unregistered.join(', ')}`,
    );
  }
  const steps = JSON.parse(readFileSync(options.steps, 'utf8'));
  const missing = Array.isArray(steps) ? missingSteps(options.session, steps) : [];
  if (missing.length > 0) {
    throw new RefusalError(
      `no ${options.session} receipt without these steps: ${missing.join(', ')}`,
    );
  }
  const receipt = buildReceipt({
    session: options.session,
    candidateSha: options['candidate-sha'],
    exeSha256: await sha256File(options.exe),
    thresholdsSha256: sha256Bytes(thresholdsBytes),
    startedUtc: options.started,
    finishedUtc: options.finished,
    steps,
    leakScan: JSON.parse(readFileSync(options['leak-scan'], 'utf8')),
  });
  writeFileSync(options.out, serializeReceipt(receipt), { encoding: 'utf8', flag: 'wx' });
  return receipt;
}

/** Runs the command. Returns the exit code: 0 written, 1 refused or invalid, 2 bad usage. */
export async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  try {
    const receipt = await writeSessionReceipt(options);
    process.stdout.write(
      `${JSON.stringify(
        {
          receipt: options.out,
          session: receipt.session,
          verdict: receipt.verdict,
          exeSha256: receipt.candidate.exeSha256,
          thresholdsSha256: receipt.thresholdsSha256,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    process.stderr.write(
      error?.code === 'EEXIST'
        ? 'the receipt file already exists; refusing to overwrite it\n'
        : `${error.message}\n`,
    );
    return 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
