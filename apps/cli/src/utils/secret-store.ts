/* global process */
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';

export interface ProtectedSecret {
  readonly scheme: 'dpapi-user' | 'file-0600';
  readonly data: string;
}

export function protectSecret(secret: string): ProtectedSecret {
  if (process.platform !== 'win32') return { scheme: 'file-0600', data: secret };
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$s=[Console]::In.ReadToEnd()',
    '$b=[Convert]::FromBase64String($s)',
    '$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Convert]::ToBase64String($p))',
  ].join(';');
  const result = runPowerShell(script, Buffer.from(secret, 'utf8').toString('base64'));
  return { scheme: 'dpapi-user', data: result };
}

export function unprotectSecret(secret: ProtectedSecret): string {
  if (secret.scheme === 'file-0600') return secret.data;
  if (process.platform !== 'win32') throw new Error('DPAPI secret is only readable on Windows');
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$s=[Console]::In.ReadToEnd()',
    '$b=[Convert]::FromBase64String($s)',
    '$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Convert]::ToBase64String($p))',
  ].join(';');
  return Buffer.from(runPowerShell(script, secret.data), 'base64').toString('utf8');
}

function runPowerShell(script: string, stdin: string): string {
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
    { input: stdin, encoding: 'utf8', windowsHide: true, shell: false },
  );
  if (result.error || result.status !== 0)
    throw new Error('Unable to access the Windows secret store');
  return result.stdout.trim();
}

export function chmodPrivate(path: string): void {
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}
