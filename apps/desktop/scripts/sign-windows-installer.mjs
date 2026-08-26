/* global process, console */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { signingConfiguration } from './sign-windows-artifacts.mjs';

const output = resolve('apps/desktop/dist-installer');
const installers = readdirSync(output).filter((name) => name.toLowerCase().endsWith('.exe'));
if (installers.length !== 1)
  throw new Error('Signing requires exactly one NSIS installer in apps/desktop/dist-installer');
const installer = join(output, installers[0]);
const { signtool, thumbprint, timestamp } = signingConfiguration(process.env);
const signed = spawnSync(
  signtool,
  ['sign', '/sha1', thumbprint, '/fd', 'SHA256', '/tr', timestamp, '/td', 'SHA256', installer],
  { stdio: 'inherit', shell: false },
);
if (signed.status !== 0) throw new Error('signtool failed; installer is not a signed release');
const escaped = installer.replaceAll("'", "''");
const verify = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escaped}'; if ($signature.Status -ne 'Valid') { Write-Error "Authenticode status: $($signature.Status)"; exit 1 }`,
  ],
  { stdio: 'inherit', shell: false },
);
if (verify.status !== 0)
  throw new Error('Authenticode verification failed; installer is not a signed release');
console.log(`Signed and verified: ${installer}`);
