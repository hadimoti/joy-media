/* global console */
import { existsSync, readFileSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import {
  checkFileAgainstManifest,
  evaluateReleaseUpdate,
  fetchLatestSignedManifest,
  parseReleaseManifest,
  parseSignatureText,
  PINNED_RELEASE_PUBLIC_KEYS_PEM,
  RELEASE_MANIFEST_FILE,
  RELEASE_SIGNATURE_FILE,
  ReleaseManifestError,
  ReleaseSourceError,
  releasePageUrl,
  verifyReleaseManifestSignature,
} from '@joy-media/release-trust';
import { CLI_VERSION, type CliFlags } from '../cli.js';
import { printJson } from '../utils/logger.js';

/** The installer's setup file name, as the release publishes it. Rollback is run from that file. */
export const SETUP_FILE_NAME = 'joy-media-setup.exe';

/**
 * Everything the command reads from the outside world. The defaults are the shipped values: the pinned keys, the
 * global fetch, the install folder that holds this executable, and the console. Tests replace each one.
 */
export interface UpdateDeps {
  readonly publicKeysPem: readonly string[];
  readonly fetch: typeof fetch;
  readonly installRoot: string;
  readonly installedVersion: string;
  readonly out: (text: string) => void;
  readonly printJson: (value: unknown) => void;
}

export interface UpdateOutcome {
  readonly ok: boolean;
  readonly status: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function defaultUpdateDeps(): UpdateDeps {
  const installRoot = dirname(process.execPath);
  return {
    publicKeysPem: PINNED_RELEASE_PUBLIC_KEYS_PEM,
    fetch: globalThis.fetch,
    installRoot,
    installedVersion: readInstalledVersion(installRoot) ?? CLI_VERSION,
    out: (text) => console.log(text),
    printJson,
  };
}

/** `joy-media update check | verify <file> | rollback`. Exit 0 when the check passes, 1 when it is refused, 2 for usage. */
export async function handleUpdateCommand(
  args: string[] = [],
  flags?: CliFlags,
  deps: UpdateDeps = defaultUpdateDeps(),
): Promise<number> {
  const [subcommand, ...rest] = args;
  let outcome: UpdateOutcome;
  if (subcommand === 'check' && rest.length === 0) outcome = await runCheck(deps);
  else if (subcommand === 'verify') outcome = await runVerify(rest, deps);
  else if (subcommand === 'rollback' && rest.length === 0) outcome = runRollback(deps);
  else return printOutcome(usageOutcome(), flags?.json === true, deps, 2);
  const code = outcome.status === 'usage' ? 2 : outcome.ok ? 0 : 1;
  return printOutcome(outcome, flags?.json === true, deps, code);
}

function printOutcome(
  outcome: UpdateOutcome,
  json: boolean,
  deps: UpdateDeps,
  code: number,
): number {
  if (json)
    deps.printJson({
      ok: outcome.ok,
      status: outcome.status,
      message: outcome.message,
      ...outcome.details,
    });
  else deps.out(outcome.message);
  return code;
}

function usageOutcome(): UpdateOutcome {
  return {
    ok: false,
    status: 'usage',
    message:
      'usage: joy-media update check | verify <file> [--manifest <path>] [--signature <path>] | rollback',
  };
}

async function runCheck(deps: UpdateDeps): Promise<UpdateOutcome> {
  // Without a trusted key nothing can verify, so no request is made.
  if (deps.publicKeysPem.length === 0) {
    return refused(
      'release-key-unconfigured',
      'This build trusts no release key, so no update can be verified.',
    );
  }
  let fetched: Awaited<ReturnType<typeof fetchLatestSignedManifest>>;
  try {
    fetched = await fetchLatestSignedManifest({ fetch: deps.fetch });
  } catch (error) {
    const reason =
      error instanceof ReleaseSourceError ? error.message : 'the release could not be checked';
    return refused('network-unavailable', `The update check could not run: ${reason}.`);
  }
  const decision = evaluateReleaseUpdate({
    manifestBytes: fetched.manifestBytes,
    signature: fetched.signature,
    installedVersion: deps.installedVersion,
    publicKeysPem: deps.publicKeysPem,
  });
  if (decision.status === 'blocked') {
    return refused(decision.reason, `The update check was refused: ${decision.reason}.`);
  }
  if (decision.status === 'current') {
    return {
      ok: true,
      status: 'current',
      message: `JOY Media ${deps.installedVersion} is the latest signed release.`,
      details: { installedVersion: deps.installedVersion, latestVersion: decision.latestVersion },
    };
  }
  const releaseUrl = releasePageUrl(decision.manifest.version);
  return {
    ok: true,
    status: 'update',
    message: `JOY Media ${decision.manifest.version} is available${decision.forced ? ' and required' : ''}: ${releaseUrl}`,
    details: {
      installedVersion: deps.installedVersion,
      latestVersion: decision.manifest.version,
      forced: decision.forced,
      releaseUrl,
    },
  };
}

async function runVerify(args: string[], deps: UpdateDeps): Promise<UpdateOutcome> {
  const parsed = parseVerifyArgs(args);
  if (parsed === undefined) return usageOutcome();
  const filePath = resolve(parsed.file);
  if (!existsSync(filePath))
    return refused('file-missing', `${basename(filePath)} does not exist.`);
  const manifestPath = resolve(parsed.manifest ?? join(dirname(filePath), RELEASE_MANIFEST_FILE));
  const signaturePath = resolve(
    parsed.signature ?? join(dirname(filePath), RELEASE_SIGNATURE_FILE),
  );
  if (!existsSync(manifestPath) || !existsSync(signaturePath)) {
    return refused(
      'manifest-missing',
      'The signed manifest or its signature is missing next to the file.',
    );
  }
  const manifestBytes = readFileSync(manifestPath);
  const signature = parseSignatureText(readFileSync(signaturePath, 'utf8'));
  if (deps.publicKeysPem.length === 0) {
    return refused(
      'release-key-unconfigured',
      'This build trusts no release key, so the manifest cannot be verified.',
    );
  }
  if (
    !verifyReleaseManifestSignature({
      manifest: manifestBytes,
      signature,
      publicKeysPem: deps.publicKeysPem,
    })
  ) {
    return refused(
      'signature-invalid',
      'The manifest signature does not verify under a trusted key.',
    );
  }
  let manifest: ReturnType<typeof parseReleaseManifest>;
  try {
    manifest = parseReleaseManifest(manifestBytes);
  } catch (error) {
    if (error instanceof ReleaseManifestError) return refused('manifest-invalid', error.message);
    throw error;
  }
  const actual = await measureFile(filePath);
  const check = checkFileAgainstManifest(manifest, basename(filePath), actual);
  if (!check.ok) {
    return refused(
      check.reason,
      `${basename(filePath)} does not match the signed manifest: ${check.reason}.`,
    );
  }
  return {
    ok: true,
    status: 'verified',
    message: `${basename(filePath)} matches the signed release ${manifest.version}.`,
    details: {
      file: basename(filePath),
      version: manifest.version,
      size: actual.size,
      sha256: actual.sha256,
    },
  };
}

/**
 * Shows the kept previous version and the installer command that performs the rollback. The rollback is not done here:
 * this command runs inside the install folder that a rollback moves, and Windows keeps that folder locked while the
 * app runs. The installer's /rollback does the move from outside it, and it is the verified path (Sandbox, 2026-10-26).
 */
function runRollback(deps: UpdateDeps): UpdateOutcome {
  const previous = `${deps.installRoot}.previous`;
  if (!existsSync(join(previous, 'joy-media.exe'))) {
    return refused(
      'no-kept-previous',
      'No kept previous version is on disk, so there is nothing to roll back to.',
    );
  }
  const restoredVersion = readInstalledVersion(previous);
  if (restoredVersion === undefined) {
    return refused(
      'version-unreadable',
      'The kept previous version could not be read, so the rollback was not planned.',
    );
  }
  return {
    ok: true,
    status: 'rollback-available',
    message:
      `JOY Media ${restoredVersion} is kept on disk. To roll back, run ${SETUP_FILE_NAME} /rollback from the ` +
      'download of the release you are running. Data is not restored by that run; add /restore-data only when you need ' +
      'the database snapshot.',
    details: {
      keptVersion: restoredVersion,
      installedVersion: deps.installedVersion,
      setupFile: SETUP_FILE_NAME,
    },
  };
}

function refused(status: string, message: string): UpdateOutcome {
  return { ok: false, status, message };
}

function parseVerifyArgs(
  args: readonly string[],
): { readonly file: string; readonly manifest?: string; readonly signature?: string } | undefined {
  let file: string | undefined;
  let manifest: string | undefined;
  let signature: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--manifest' || arg === '--signature') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) return undefined;
      if (arg === '--manifest') manifest = value;
      else signature = value;
      index += 1;
    } else if (arg.startsWith('--') || file !== undefined) {
      return undefined;
    } else {
      file = arg;
    }
  }
  if (file === undefined) return undefined;
  return {
    file,
    ...(manifest === undefined ? {} : { manifest }),
    ...(signature === undefined ? {} : { signature }),
  };
}

function measureFile(path: string): Promise<{ readonly size: number; readonly sha256: string }> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    let size = 0;
    const stream = createReadStream(path);
    stream.on('data', (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += bytes.length;
      hash.update(bytes);
    });
    stream.on('error', reject);
    stream.on('end', () => resolvePromise({ size, sha256: hash.digest('hex') }));
  });
}

function readInstalledVersion(root: string): string | undefined {
  const manifestPath = join(root, 'resources', 'app', 'package.json');
  if (!existsSync(manifestPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const version = (parsed as Record<string, unknown>)['version'];
      if (typeof version === 'string') return version;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
