import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkFileAgainstManifest } from '../../../packages/release-trust/src/files.ts';
import { parseReleaseManifest } from '../../../packages/release-trust/src/manifest.ts';
import { evaluateReleaseUpdate } from '../../../packages/release-trust/src/policy.ts';

// The owner's signing ceremony, rehearsed with throwaway keys (plan D2; docs/release/owner-checklists/signing-d2.md).
// It runs the commands the owner runs, then checks the result with the functions that `joy-media update check` and
// `joy-media update verify` call. Every key here is a test key in a temporary folder. None is pinned, and none is the
// release key.
const here = dirname(fileURLToPath(import.meta.url));
const builder = join(here, 'build-release-manifest.mjs');
const signer = join(here, 'sign-release-manifest.mjs');
const SETUP = 'joy-media-setup.exe';
const ZIP = 'joy-media-windows-x64-v1.0.3.zip';
const SETUP_BYTES = Buffer.from('rehearsal setup bytes\n', 'utf8');
const ZIP_BYTES = Buffer.from('rehearsal archive bytes\n', 'utf8');
const PASSPHRASE = 'rehearsal only, not the owner key';

let root: string;
let release: string;
let passFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'release-ceremony-'));
  release = join(root, 'release');
  mkdirSync(release);
  writeFileSync(join(release, SETUP), SETUP_BYTES);
  writeFileSync(join(release, ZIP), ZIP_BYTES);
  passFile = join(root, 'passphrase.txt');
  writeFileSync(passFile, `${PASSPHRASE}\n`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runNode(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The release key ceremony command, exactly as the owner runs it, into a folder of its own. */
function keygen(outDir: string): { privatePath: string; publicPem: string } {
  mkdirSync(outDir);
  const result = runNode(signer, [
    'keygen',
    '--purpose',
    'release',
    '--out-dir',
    outDir,
    '--passphrase-file',
    passFile,
  ]);
  expect(result.status).toBe(0);
  const record = JSON.parse(result.stdout) as { keyId: string; purpose: string };
  expect(record.purpose).toBe('release');
  return {
    privatePath: join(outDir, `${record.keyId}.private.pem`),
    publicPem: readFileSync(join(outDir, `${record.keyId}.public.pem`), 'utf8'),
  };
}

function buildManifest(out: string): void {
  const result = runNode(builder, [
    '--release-dir',
    release,
    '--version',
    '1.0.3',
    '--channel',
    'stable',
    '--issued-at',
    '2026-10-28T12:00:00Z',
    '--min-supported',
    '1.0.2',
    '--file',
    SETUP,
    '--file',
    ZIP,
    '--out',
    out,
  ]);
  expect(result.status).toBe(0);
}

describe('the signing ceremony, rehearsed with throwaway keys', () => {
  it('signs a built manifest, and the shipped verifier accepts it under the key that was generated', () => {
    const manifestPath = join(release, 'release-manifest.json');
    const sigPath = join(release, 'release-manifest.json.sig');
    buildManifest(manifestPath);
    const key = keygen(join(root, 'keys'));

    expect(
      runNode(signer, [
        'sign',
        '--manifest',
        manifestPath,
        '--key',
        key.privatePath,
        '--passphrase-file',
        passFile,
        '--out',
        sigPath,
      ]).status,
    ).toBe(0);
    const pubPath = join(root, 'release-public.pem');
    writeFileSync(pubPath, key.publicPem);
    const tool = runNode(signer, [
      'verify',
      '--manifest',
      manifestPath,
      '--sig',
      sigPath,
      '--pub',
      pubPath,
    ]);
    expect(tool.stdout).toBe('signature verified\n');

    // The same check `update check` makes, with this key given in place of the pinned list.
    const manifestBytes = readFileSync(manifestPath);
    const signature = readFileSync(sigPath, 'utf8');
    expect(
      evaluateReleaseUpdate({
        manifestBytes,
        signature,
        installedVersion: '1.0.2',
        publicKeysPem: [key.publicPem],
      }),
    ).toMatchObject({ status: 'update', forced: false, manifest: { version: '1.0.3' } });
    expect(
      evaluateReleaseUpdate({
        manifestBytes,
        signature,
        installedVersion: '1.0.1',
        publicKeysPem: [key.publicPem],
      }),
    ).toMatchObject({ status: 'update', forced: true });

    // The same check `update verify` makes on a downloaded file.
    const manifest = parseReleaseManifest(manifestBytes);
    const setupBytes = readFileSync(join(release, SETUP));
    expect(
      checkFileAgainstManifest(manifest, SETUP, {
        size: setupBytes.length,
        sha256: sha256(setupBytes),
      }),
    ).toMatchObject({ ok: true });
  });

  it('refuses a changed manifest, a changed file, a signature from another key, and an empty key list', () => {
    const manifestPath = join(release, 'release-manifest.json');
    const sigPath = join(release, 'release-manifest.json.sig');
    buildManifest(manifestPath);
    const key = keygen(join(root, 'keys'));
    const other = keygen(join(root, 'keys-other'));
    expect(
      runNode(signer, [
        'sign',
        '--manifest',
        manifestPath,
        '--key',
        key.privatePath,
        '--passphrase-file',
        passFile,
        '--out',
        sigPath,
      ]).status,
    ).toBe(0);
    const manifestBytes = readFileSync(manifestPath);
    const signature = readFileSync(sigPath, 'utf8');

    const edited = Buffer.from(manifestBytes.toString('utf8').replace('1.0.3', '1.0.4'), 'utf8');
    expect(
      evaluateReleaseUpdate({
        manifestBytes: edited,
        signature,
        installedVersion: '1.0.2',
        publicKeysPem: [key.publicPem],
      }),
    ).toEqual({ status: 'blocked', reason: 'signature-invalid' });
    expect(
      evaluateReleaseUpdate({
        manifestBytes,
        signature,
        installedVersion: '1.0.2',
        publicKeysPem: [other.publicPem],
      }),
    ).toEqual({ status: 'blocked', reason: 'signature-invalid' });
    expect(
      evaluateReleaseUpdate({
        manifestBytes,
        signature,
        installedVersion: '1.0.2',
        publicKeysPem: [],
      }),
    ).toEqual({ status: 'blocked', reason: 'release-key-unconfigured' });

    const manifest = parseReleaseManifest(manifestBytes);
    const changedSetup = Buffer.from('a different setup file\n', 'utf8');
    expect(
      checkFileAgainstManifest(manifest, SETUP, {
        size: changedSetup.length,
        sha256: sha256(changedSetup),
      }),
    ).toEqual({ ok: false, reason: 'size-mismatch' });
    expect(
      checkFileAgainstManifest(manifest, 'unlisted.exe', {
        size: SETUP_BYTES.length,
        sha256: sha256(SETUP_BYTES),
      }),
    ).toEqual({ ok: false, reason: 'not-listed' });
  });

  it('never overwrites a signature that already exists', () => {
    const manifestPath = join(release, 'release-manifest.json');
    const sigPath = join(release, 'release-manifest.json.sig');
    buildManifest(manifestPath);
    const key = keygen(join(root, 'keys'));
    const signArgs = [
      'sign',
      '--manifest',
      manifestPath,
      '--key',
      key.privatePath,
      '--passphrase-file',
      passFile,
      '--out',
      sigPath,
    ];
    expect(runNode(signer, signArgs).status).toBe(0);
    const first = readFileSync(sigPath, 'utf8');
    expect(runNode(signer, signArgs).status).not.toBe(0);
    expect(readFileSync(sigPath, 'utf8')).toBe(first);
  });
});
