/* global process, console, URL */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export function signingConfiguration(env = process.env) {
  const signtool = env.JOY_SIGNTOOL_PATH?.trim();
  const thumbprint = env.JOY_SIGNING_CERT_THUMBPRINT?.trim();
  const timestamp = (env.JOY_SIGNING_TIMESTAMP_URL ?? 'https://timestamp.digicert.com').trim();
  if (!signtool || !thumbprint)
    throw new Error(
      'Refusing unsigned release: owner must provide JOY_SIGNTOOL_PATH and JOY_SIGNING_CERT_THUMBPRINT at release time',
    );
  let parsedTimestamp;
  try {
    parsedTimestamp = new URL(timestamp);
  } catch {
    throw new Error('Signing timestamp URL must be HTTPS');
  }
  if (parsedTimestamp.protocol !== 'https:') throw new Error('Signing timestamp URL must be HTTPS');
  return { signtool, thumbprint, timestamp };
}

function executableFiles(root) {
  const files = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stats = statSync(path);
    if (stats.isDirectory()) files.push(...executableFiles(path));
    else if (name.toLowerCase().endsWith('.exe')) files.push(path);
  }
  return files;
}

export function signExecutableFiles(root, options = {}) {
  const config = options.config ?? signingConfiguration(options.env ?? process.env);
  const run =
    options.run ?? ((file, args) => spawnSync(file, args, { stdio: 'inherit', shell: false }));
  const verify = options.verify ?? verifyAuthenticode;
  const files = executableFiles(root);
  if (files.length === 0) throw new Error(`No executable helpers found to sign in ${root}`);
  for (const file of files) {
    const result = run(config.signtool, [
      'sign',
      '/sha1',
      config.thumbprint,
      '/fd',
      'SHA256',
      '/tr',
      config.timestamp,
      '/td',
      'SHA256',
      file,
    ]);
    if (result.status !== 0) throw new Error(`signtool failed for ${file}`);
    if (!verify(file)) throw new Error(`Authenticode verification failed for ${file}`);
  }
  return files;
}

function verifyAuthenticode(file) {
  const escaped = file.replaceAll("'", "''");
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$signature = Get-AuthenticodeSignature -LiteralPath '${escaped}'; if ($signature.Status -ne 'Valid') { exit 1 }`,
    ],
    { stdio: 'inherit', shell: false },
  );
  return result.status === 0;
}

/** electron-builder afterPack hook: sign every installed executable before NSIS packaging. */
export default async function afterPack(context) {
  if (process.env.JOY_MEDIA_REQUIRE_SIGNING !== '1') return;
  if (context.electronPlatformName !== 'win32') return;
  const files = signExecutableFiles(resolve(context.appOutDir));
  console.log(`Signed ${files.length} installed executable(s)`);
}
