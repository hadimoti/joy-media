// Signs and checks a release manifest with an Ed25519 key that the caller names at run time.
//
// The key is never read from the repository, from CI or from a default path. The owner keeps the private key
// offline and runs `sign` locally; CI and the tests only ever use development keys. The signature covers the
// exact bytes of the manifest file, and it is written as unpadded base64url, the form the desktop verifier accepts
// (apps/desktop/src/main/release-manifest-signature.ts).
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Returns the detached signature of `manifest` (exact bytes) as unpadded base64url. */
export function signManifestBytes(manifest, privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
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

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) throw new Error(`Missing ${name}.`);
  return args[index + 1];
}

function main(args) {
  const [command] = args;
  if (command === 'sign') {
    const manifest = readFileSync(option(args, '--manifest'));
    const privateKeyPem = readFileSync(option(args, '--key'), 'utf8');
    writeFileSync(option(args, '--out'), `${signManifestBytes(manifest, privateKeyPem)}\n`, 'utf8');
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
  process.stderr.write('usage: sign-release-manifest.mjs sign|verify --manifest <file> ...\n');
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
