// Development keys only, except where a test checks the owner path's refusals. No test here reads or writes a real release key.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateSigningKey,
  keyFingerprint,
  signManifestBytes,
  verifyManifestBytes,
  writeKeyFiles,
} from './sign-release-manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(here, '../../../');
const script = join(here, 'sign-release-manifest.mjs');
const MANIFEST = Buffer.from('{"channel":"stable","version":"1.0.4"}\n', 'utf8');
const PASSPHRASE = 'correct horse battery';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sign-keygen-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function cli(args: string[]): string {
  return execFileSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('development keys', () => {
  it('are labelled in the key id and the record, and sign and verify', () => {
    const key = generateSigningKey({ purpose: 'development' });
    expect(key.keyId.startsWith('development-')).toBe(true);

    const signature = signManifestBytes(MANIFEST, key.privatePem);
    expect(verifyManifestBytes(MANIFEST, signature, key.publicPem)).toBe(true);
    expect(
      verifyManifestBytes(Buffer.concat([MANIFEST, Buffer.from(' ')]), signature, key.publicPem),
    ).toBe(false);
  });

  it('write the three files under new names, with the record marked not for release', () => {
    const key = generateSigningKey({ purpose: 'development' });
    const record = writeKeyFiles(directory, key, {});

    expect(record).toMatchObject({
      purpose: 'development',
      algorithm: 'ed25519',
      notForRelease: true,
    });
    expect(readFileSync(join(directory, `${key.keyId}.public.pem`), 'utf8')).toBe(key.publicPem);
    expect(() => writeKeyFiles(directory, key, {})).toThrow(/EEXIST/u);
  });
});

describe('the release key (owner path)', () => {
  it('refuses to generate without a passphrase of at least 12 characters', () => {
    expect(() => generateSigningKey({ purpose: 'release' })).toThrow(/passphrase of at least 12/u);
    expect(() => generateSigningKey({ purpose: 'release', passphrase: 'short' })).toThrow(
      /passphrase of at least 12/u,
    );
  });

  it('stores the private key encrypted, and signs only with the right passphrase', () => {
    const key = generateSigningKey({ purpose: 'release', passphrase: PASSPHRASE });
    expect(key.keyId.startsWith('release-')).toBe(true);
    expect(key.privatePem).toContain('ENCRYPTED PRIVATE KEY');

    const signature = signManifestBytes(MANIFEST, key.privatePem, PASSPHRASE);
    expect(verifyManifestBytes(MANIFEST, signature, key.publicPem)).toBe(true);
    expect(() => signManifestBytes(MANIFEST, key.privatePem, 'wrong passphrase!!')).toThrow();
    expect(() => signManifestBytes(MANIFEST, key.privatePem)).toThrow();
  });

  it('refuses an unknown purpose', () => {
    expect(() => generateSigningKey({ purpose: 'nightly' })).toThrow(/development or release/u);
  });

  it('refuses a key folder inside this checkout, and creates nothing there', () => {
    const key = generateSigningKey({ purpose: 'development' });
    const inside = join(checkout, 'key-folder-that-must-not-exist');

    expect(() => writeKeyFiles(inside, key, {})).toThrow(/outside this checkout/u);
    expect(existsSync(inside)).toBe(false);
  });

  it('refuses a key folder inside a runner work folder', () => {
    const key = generateSigningKey({ purpose: 'development' });
    expect(() => writeKeyFiles(join(directory, '_work', 'keys'), key, {})).toThrow(
      /outside this checkout/u,
    );
  });

  it('names the fingerprint the same way in the record and in the fingerprint command', () => {
    const key = generateSigningKey({ purpose: 'development' });
    writeKeyFiles(directory, key, {});
    const publicPath = join(directory, `${key.keyId}.public.pem`);

    const printed = cli(['fingerprint', '--pub', publicPath]).trim();
    expect(printed).toBe(keyFingerprint(key.publicPem));
    expect(
      JSON.parse(readFileSync(join(directory, `${key.keyId}.key.json`), 'utf8')).fingerprint,
    ).toBe(printed);
  });
});

describe('the command line', () => {
  it('generates a development key into a new folder, and prints only the public record', () => {
    const out = join(directory, 'dev-keys');
    const stdout = cli(['keygen', '--purpose', 'development', '--out-dir', out]);

    const record = JSON.parse(stdout);
    expect(record).toMatchObject({ purpose: 'development', notForRelease: true });
    expect(stdout).not.toContain('PRIVATE KEY');
  });

  it('refuses a release key without a passphrase file, and does not take the passphrase from the command line', () => {
    const out = join(directory, 'release-keys');
    expect(() =>
      cli(['keygen', '--purpose', 'release', '--out-dir', out, '--passphrase', PASSPHRASE]),
    ).toThrow();
    expect(existsSync(out)).toBe(false);
  });

  it('generates a release key from a passphrase file, and the owner can sign with it', () => {
    const passphraseFile = join(directory, 'passphrase.txt');
    writeFileSync(passphraseFile, `${PASSPHRASE}\n`);
    const out = join(directory, 'release-keys');

    const record = JSON.parse(
      cli([
        'keygen',
        '--purpose',
        'release',
        '--out-dir',
        out,
        '--passphrase-file',
        passphraseFile,
      ]),
    );
    const keyPath = join(out, `${record.keyId}.private.pem`);
    const publicPath = join(out, `${record.keyId}.public.pem`);
    const manifestPath = join(directory, 'release-manifest.json');
    const sigPath = join(directory, 'release-manifest.json.sig');
    writeFileSync(manifestPath, MANIFEST);

    cli([
      'sign',
      '--manifest',
      manifestPath,
      '--key',
      keyPath,
      '--passphrase-file',
      passphraseFile,
      '--out',
      sigPath,
    ]);

    expect(
      cli(['verify', '--manifest', manifestPath, '--sig', sigPath, '--pub', publicPath]),
    ).toContain('signature verified');
    expect(() =>
      cli([
        'sign',
        '--manifest',
        manifestPath,
        '--key',
        keyPath,
        '--out',
        join(directory, 'x.sig'),
      ]),
    ).toThrow();
  });

  it('never overwrites an existing signature', () => {
    const key = generateSigningKey({ purpose: 'development' });
    const keyPath = join(directory, 'dev.pem');
    const manifestPath = join(directory, 'manifest.json');
    const sigPath = join(directory, 'manifest.json.sig');
    writeFileSync(keyPath, key.privatePem);
    writeFileSync(manifestPath, MANIFEST);
    writeFileSync(sigPath, 'already here\n');

    expect(() =>
      cli(['sign', '--manifest', manifestPath, '--key', keyPath, '--out', sigPath]),
    ).toThrow();
    expect(readFileSync(sigPath, 'utf8')).toBe('already here\n');
  });
});
