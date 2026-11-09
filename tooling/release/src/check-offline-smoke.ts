/**
 * The CI check for an attended offline-smoke receipt (plan section 8b, and 17e/17f: the Windows lanes run attended).
 *
 * The owner runs the packaged app on their PC against the exact candidate artifact, records the receipt, and commits it
 * under docs/release/attended/<candidate-sha>/offline-smoke.json with the artifact digests in SHA256SUMS.txt beside it.
 * This check reads the receipt, takes the artifact digest from the SHA256SUMS.txt line for the artifact, and refuses the
 * receipt unless it binds to the candidate, the artifact and the run window.
 *
 *   node --experimental-strip-types tooling/release/src/check-offline-smoke.ts \
 *     --candidate <40-hex> --receipt <offline-smoke.json> --sums <SHA256SUMS.txt> \
 *     --artifact <name> --window-start <UTC> --window-end <UTC>
 *
 * Exit 0 = accepted; exit 1 = refused (reasons on stderr); exit 2 = bad usage.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOfflineSmokeReceiptText } from './offline-smoke-receipt.ts';

export interface OfflineSmokeCheckArgs {
  readonly candidate: string;
  readonly receiptPath: string;
  readonly sumsPath: string;
  readonly artifact: string;
  readonly windowStart: string;
  readonly windowEnd: string;
}

export interface OfflineSmokeCheckIo {
  readonly readText: (path: string) => string | undefined;
}

export interface OfflineSmokeCheckOutcome {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

const CHECKSUM_LINE = /^([0-9a-f]{64}) [ *](.+)$/u;

/** The SHA-256 digest that SHA256SUMS.txt records for one file name, or undefined when no line names it. */
export function digestFor(sums: string, artifact: string): string | undefined {
  for (const line of sums.split(/\r?\n/u)) {
    const match = CHECKSUM_LINE.exec(line.trim());
    if (match !== null && match[2] === artifact) return match[1];
  }
  return undefined;
}

/** Checks one attended receipt. A missing SHA256SUMS line refuses the receipt, because the digest then cannot be bound. */
export function checkOfflineSmoke(
  args: OfflineSmokeCheckArgs,
  io: OfflineSmokeCheckIo,
): OfflineSmokeCheckOutcome {
  const sums = io.readText(args.sumsPath);
  if (sums === undefined) {
    return { ok: false, reasons: ['SHA256SUMS.txt is missing for the candidate'] };
  }
  const digest = digestFor(sums, args.artifact);
  if (digest === undefined) {
    return { ok: false, reasons: [`SHA256SUMS.txt has no line for ${args.artifact}`] };
  }
  return validateOfflineSmokeReceiptText(io.readText(args.receiptPath), {
    candidateSha: args.candidate,
    artifactName: args.artifact,
    artifactSha256: digest,
    runWindow: { start: args.windowStart, end: args.windowEnd },
  });
}

const FLAGS = ['candidate', 'receipt', 'sums', 'artifact', 'window-start', 'window-end'] as const;

/** Parses `--name value` pairs. Every flag is required; an unknown or unpaired flag is a usage error. */
export function parseOfflineSmokeArgs(argv: readonly string[]): OfflineSmokeCheckArgs | string {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      key === undefined ||
      !key.startsWith('--') ||
      value === undefined ||
      value.startsWith('--')
    ) {
      return `expected --name value pairs, got: ${String(key)}`;
    }
    const name = key.slice(2);
    if (!(FLAGS as readonly string[]).includes(name)) return `unknown option: ${key}`;
    values[name] = value;
  }
  for (const flag of FLAGS) {
    if (values[flag] === undefined) return `missing --${flag}`;
  }
  return {
    candidate: values.candidate ?? '',
    receiptPath: values.receipt ?? '',
    sumsPath: values.sums ?? '',
    artifact: values.artifact ?? '',
    windowStart: values['window-start'] ?? '',
    windowEnd: values['window-end'] ?? '',
  };
}

function main(argv: readonly string[]): number {
  const parsed = parseOfflineSmokeArgs(argv);
  if (typeof parsed === 'string') {
    process.stderr.write(`${parsed}\n`);
    return 2;
  }
  const outcome = checkOfflineSmoke(parsed, {
    readText: (path) => {
      try {
        return readFileSync(resolve(path), 'utf8');
      } catch {
        return undefined;
      }
    },
  });
  if (!outcome.ok) {
    for (const reason of outcome.reasons) process.stderr.write(`offline-smoke: ${reason}\n`);
    return 1;
  }
  process.stdout.write(`offline-smoke receipt accepted for ${parsed.candidate}\n`);
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
