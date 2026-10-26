// Generates, signs and checks release manifests with Ed25519 keys (plan §3.1, decision D2).
//
//   keygen      --purpose development|release --out-dir <dir> [--passphrase-file <file>]
//   fingerprint --pub <file>
//   sign        --manifest <file> --key <file> --out <file> [--passphrase-file <file>]
//   verify      --manifest <file> --sig <file> --pub <file>
//
// Development keys are for CI and tests. They are labelled in their file names and in their key record, and no build
// pins them. The owner creates the release key once, offline, with `keygen --purpose release`. Its private key is
// encrypted with a passphrase of at least 12 characters, read from a file, never from the command line. Nothing in this
// repository, in CI, in receipts or in gbrain holds the release private key. The key is never read from a default path.
//
// Every signature covers the exact bytes of the manifest file, written as unpadded base64url. That is the form the
// desktop verifier accepts (packages/release-trust/src/signature.ts).
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKOUT = fileURLToPath(new URL('../../../', import.meta.url));
const PURPOSES = new Set(['development', 'release']);
const MIN_PASSPHRASE = 12;

/** Returns the detached signature of `manifest` (exact bytes) as unpadded base64url. */
export function signManifestBytes(manifest, privateKeyPem, passphrase) {
  const options =
    passphrase === undefined ? { key: privateKeyPem } : { key: privateKeyPem, passphrase };
  const key = createPrivateKey(options);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The release key must be Ed25519.');
  return sign(null, manifest, key).toString('base64url');
}

/** True when `signature` is a valid Ed25519 signature of `manifest` under `publicKeyPem`. */
export function verifyManifestBytes(manifest, signature, publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') return false;
  const bytes = Buffer.from(signature, 'base64url');
  return bytes.length === 64 && verify(null, manifest, key, bytes);
}

/** SHA-256 of the DER public key. The owner records it, and a pinned key must match it. */
export function keyFingerprint(publicPem) {
  const der = createPublicKey(publicPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/** Generates an Ed25519 key pair. A release private key is encrypted; a development key is labelled as one. */
export function generateSigningKey({ purpose, passphrase }) {
  if (!PURPOSES.has(purpose)) throw new Error('--purpose must be development or release.');
  const privateEncoding = { type: 'pkcs8', format: 'pem' };
  if (purpose === 'release') {
    if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
      throw new Error(
        `A release key needs a passphrase of at least ${MIN_PASSPHRASE} characters, read from --passphrase-file.`,
      );
    }
    Object.assign(privateEncoding, { cipher: 'aes-256-cbc', passphrase });
  }
  const pair = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: privateEncoding,
  });
  const fingerprint = keyFingerprint(pair.publicKey);
  return {
    purpose,
    fingerprint,
    keyId: `${purpose}-${fingerprint.slice(0, 16)}`,
    privatePem: pair.privateKey,
    publicPem: pair.publicKey,
  };
}

/** Refuses an output folder inside this checkout, a runner workspace, or a runner work folder. */
export function assertKeyLocation(outDir, env = process.env) {
  const target = resolve(outDir);
  const within = (anchor) => {
    const rel = relative(resolve(anchor), target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  const workspace = env.RUNNER_WORKSPACE ?? '';
  const segments = target.split(sep);
  if (within(CHECKOUT) || (workspace !== '' && within(workspace)) || segments.includes('_work')) {
    throw new Error('the key folder must be outside this checkout and any runner workspace');
  }
}

/**
 * Writes the key files. Every name is new: an existing file is never overwritten. A development key is marked
 * `notForRelease` in its record, and its file names start with `development-`.
 */
export function writeKeyFiles(outDir, key, env = process.env) {
  assertKeyLocation(outDir, env);
  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, key.keyId);
  const record = {
    schemaVersion: 1,
    keyId: key.keyId,
    purpose: key.purpose,
    algorithm: 'ed25519',
    fingerprint: key.fingerprint,
    createdAt: new Date().toISOString(),
    ...(key.purpose === 'development'
      ? { notForRelease: true, warning: 'DEVELOPMENT KEY. No build may pin it.' }
      : {}),
  };
  writeFileSync(`${base}.private.pem`, key.privatePem, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(`${base}.public.pem`, key.publicPem, { encoding: 'utf8', flag: 'wx' });
  writeFileSync(`${base}.key.json`, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return record;
}

function option(args, name) {
  const value = optionalOption(args, name);
  if (value === undefined) throw new Error(`Missing ${name}.`);
  return value;
}

function optionalOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (index + 1 >= args.length) throw new Error(`Missing ${name}.`);
  return args[index + 1];
}

/** The passphrase comes only from a file, so it never appears in a command line, a shell history or a log. */
function passphraseFromFile(args) {
  const file = optionalOption(args, '--passphrase-file');
  if (file === undefined) return undefined;
  return readFileSync(file, 'utf8').replace(/\r?\n$/u, '');
}

function main(args, env = process.env) {
  const [command] = args;
  if (command === 'keygen') {
    const key = generateSigningKey({
      purpose: option(args, '--purpose'),
      passphrase: passphraseFromFile(args),
    });
    const record = writeKeyFiles(option(args, '--out-dir'), key, env);
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return 0;
  }
  if (command === 'fingerprint') {
    process.stdout.write(`${keyFingerprint(readFileSync(option(args, '--pub'), 'utf8'))}\n`);
    return 0;
  }
  if (command === 'sign') {
    const manifest = readFileSync(option(args, '--manifest'));
    const privateKeyPem = readFileSync(option(args, '--key'), 'utf8');
    const signature = signManifestBytes(manifest, privateKeyPem, passphraseFromFile(args));
    writeFileSync(option(args, '--out'), `${signature}\n`, { encoding: 'utf8', flag: 'wx' });
    return 0;
  }
  if (command === 'verify') {
    const manifest = readFileSync(option(args, '--manifest'));
    const signature = readFileSync(option(args, '--sig'), 'utf8').trim();
    const publicKeyPem = readFileSync(option(args, '--pub'), 'utf8');
    const ok = verifyManifestBytes(manifest, signature, publicKeyPem);
    process.stdout.write(ok ? 'signature verified\n' : 'signature REFUSED\n');
    return ok ? 0 : 1;
  }
  process.stderr.write(
    'usage: sign-release-manifest.mjs keygen|fingerprint|sign|verify (see the header of this file)\n',
  );
  return 2;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
