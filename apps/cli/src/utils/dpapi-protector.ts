import { spawnSync } from 'node:child_process';
import { powershellOptions } from './windows-powershell.js';

/**
 * Protects a secret for the signed-in Windows user. The protector is injected into the credential store,
 * so the store and its migration are tested on every platform, with a fake protector where DPAPI is absent.
 */
export interface SecretProtector {
  /** Written into the store file, so a store is never read by a different protector. */
  readonly name: string;
  protect(plain: string): string;
  unprotect(cipher: string): string;
}

const PREAMBLE = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security;";
const PROTECT_SCRIPT = `${PREAMBLE} $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($protected))`;
const UNPROTECT_SCRIPT = `${PREAMBLE} $protected=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $bytes=[Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($bytes))`;
const TIMEOUT_MS = 30_000;

/**
 * Runs one short-lived PowerShell call through the fixed program path. The data goes on stdin, never on
 * the command line, and the error carries no data.
 */
function runProtectorScript(script: string, input: string): string {
  const options = powershellOptions();
  const result = spawnSync(
    options.file,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { input, encoding: 'utf8', env: options.env, windowsHide: true, timeout: TIMEOUT_MS },
  );
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    throw new Error('Windows DPAPI could not complete the request');
  }
  const output = result.stdout.trim();
  if (output.length === 0) throw new Error('Windows DPAPI returned no data');
  return output;
}

/** The signed-in user's DPAPI (CurrentUser scope), through the fixed PowerShell program. */
export function createDpapiProtector(): SecretProtector {
  return {
    name: 'dpapi-currentuser',
    protect: (plain) =>
      runProtectorScript(PROTECT_SCRIPT, Buffer.from(plain, 'utf8').toString('base64')),
    unprotect: (cipher) =>
      Buffer.from(runProtectorScript(UNPROTECT_SCRIPT, cipher), 'base64').toString('utf8'),
  };
}

/**
 * The fallback where DPAPI does not exist (PLAN-v4 §6b): the store file itself is restricted to its owner
 * (mode 0600). The values are not encrypted, and the ADR says so.
 */
export function createRestrictedFileProtector(): SecretProtector {
  return {
    name: 'restricted-file',
    protect: (plain) => plain,
    unprotect: (cipher) => cipher,
  };
}
