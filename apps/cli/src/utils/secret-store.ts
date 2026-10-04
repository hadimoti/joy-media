/* global process */
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';

export interface ProtectedSecret {
  readonly scheme: 'dpapi-user' | 'keychain' | 'libsecret' | 'file-0600';
  readonly data: string;
  readonly account?: string;
}

export interface SecretStoreRunnerResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly error?: Error;
}

export type SecretStoreRunner = (
  command: string,
  args: readonly string[],
  stdin?: string,
) => SecretStoreRunnerResult;

const defaultRunner: SecretStoreRunner = (command, args, stdin) => {
  const result = spawnSync(command, [...args], {
    input: stdin,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 1800,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
};

let secretStoreRuntime: { platform: NodeJS.Platform; runner: SecretStoreRunner } = {
  platform: process.platform,
  runner: defaultRunner,
};

/** Injects platform and process execution for tests; production uses the current host. */
export function configureSecretStoreRuntimeForTests(runtime: {
  platform: NodeJS.Platform;
  runner: SecretStoreRunner;
}): () => void {
  const previous = secretStoreRuntime;
  secretStoreRuntime = runtime;
  return () => {
    secretStoreRuntime = previous;
  };
}

export function protectSecret(
  secret: string,
  account = 'default',
  options: { insecureFileStore?: boolean } = {},
): ProtectedSecret {
  if (secretStoreRuntime.platform === 'win32') {
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
  validateSecret(secret);
  validateAccount(account);
  if (options.insecureFileStore) return { scheme: 'file-0600', data: secret };
  const { platform, runner } = secretStoreRuntime;
  if (platform === 'darwin') {
    const input = `add-generic-password -U -a ${quoteSecurity(account)} -s ${quoteSecurity('joy-media')} -w ${quoteSecurity(secret)}\nquit\n`;
    const stored = runner('/usr/bin/security', ['-i'], input);
    if (!ok(stored)) throw keyringUnavailableError();
    const verified = runner('/usr/bin/security', [
      'find-generic-password',
      '-a',
      account,
      '-s',
      'joy-media',
      '-w',
    ]);
    if (!ok(verified) || verified.stdout.replace(/[\r\n]+$/, '') !== secret)
      throw new Error('macOS Keychain could not verify the stored API key.');
    return { scheme: 'keychain', data: account, account };
  }
  if (platform === 'linux') {
    const stored = runner(
      'secret-tool',
      ['store', '--label=JOY Media API key', 'service', 'joy-media', 'account', account],
      secret,
    );
    if (!ok(stored)) throw keyringUnavailableError();
    const verified = runner('secret-tool', ['lookup', 'service', 'joy-media', 'account', account]);
    if (!ok(verified) || verified.stdout.replace(/[\r\n]+$/, '') !== secret)
      throw new Error('Linux keyring could not verify the stored API key.');
    return { scheme: 'libsecret', data: account, account };
  }
  throw keyringUnavailableError();
}

export function unprotectSecret(secret: ProtectedSecret): string {
  if (secret.scheme === 'file-0600') return secret.data;
  if (secret.scheme === 'dpapi-user') {
    if (secretStoreRuntime.platform !== 'win32')
      throw new Error('DPAPI secret is only readable on Windows');
    const script = [
      'Add-Type -AssemblyName System.Security',
      '$s=[Console]::In.ReadToEnd()',
      '$b=[Convert]::FromBase64String($s)',
      '$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[Console]::Out.Write([Convert]::ToBase64String($p))',
    ].join(';');
    return Buffer.from(runPowerShell(script, secret.data), 'base64').toString('utf8');
  }
  const account = secret.account ?? secret.data;
  validateAccount(account);
  const { platform, runner } = secretStoreRuntime;
  const result =
    platform === 'darwin'
      ? runner('/usr/bin/security', [
          'find-generic-password',
          '-a',
          account,
          '-s',
          'joy-media',
          '-w',
        ])
      : platform === 'linux'
        ? runner('secret-tool', ['lookup', 'service', 'joy-media', 'account', account])
        : undefined;
  if (!result || !ok(result)) throw new Error('Unable to read API key from the system keyring.');
  return result.stdout.replace(/[\r\n]+$/, '');
}

export function deleteProtectedSecret(secret: ProtectedSecret): boolean {
  if (secret.scheme === 'file-0600' || secret.scheme === 'dpapi-user') return true;
  const account = secret.account ?? secret.data;
  const result =
    secret.scheme === 'keychain'
      ? secretStoreRuntime.runner('/usr/bin/security', [
          'delete-generic-password',
          '-a',
          account,
          '-s',
          'joy-media',
        ])
      : secretStoreRuntime.runner('secret-tool', [
          'clear',
          'service',
          'joy-media',
          'account',
          account,
        ]);
  return ok(result);
}

function validateSecret(secret: string): void {
  if (
    typeof secret !== 'string' ||
    secret.length === 0 ||
    [...secret].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    })
  )
    throw new Error(
      'API keys must be non-empty and cannot contain control characters or newlines.',
    );
}

function validateAccount(account: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(account))
    throw new Error(
      'Provider keyring account must use letters, numbers, dots, underscores, or hyphens.',
    );
}

function quoteSecurity(value: string): string {
  validateSecret(value);
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function keyringUnavailableError(): Error {
  return new Error(
    'No usable system keyring is available. Use --api-key-env <VAR>, or opt in to plaintext with --insecure-file-store.',
  );
}

function ok(result: SecretStoreRunnerResult): boolean {
  return result.status === 0 && !result.error;
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
  if (secretStoreRuntime.platform !== 'win32') chmodSync(path, 0o600);
}
