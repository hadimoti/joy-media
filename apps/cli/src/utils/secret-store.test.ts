import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureSecretStoreRuntimeForTests,
  deleteProtectedSecret,
  protectSecret,
  unprotectSecret,
  type SecretStoreRunner,
} from './secret-store.js';
import { getAiProvidersPath, loadAiProviders, saveAiProviders } from './config.js';

describe('CLI secret storage', () => {
  it('stores and looks up macOS keys through stdin without placing the key in argv', () => {
    const calls: Array<{ command: string; args: readonly string[]; stdin?: string }> = [];
    const runner: SecretStoreRunner = (command, args, stdin) => {
      calls.push({ command, args, ...(stdin === undefined ? {} : { stdin }) });
      return {
        status: 0,
        stdout:
          command.endsWith('security') && args[0] === 'find-generic-password'
            ? 'sk-test-REDACTED-0000\n'
            : '',
      };
    };
    const restore = configureSecretStoreRuntimeForTests({ platform: 'darwin', runner });
    try {
      const secret = protectSecret('sk-test-REDACTED-0000', 'provider-a');
      expect(secret.scheme).toBe('keychain');
      expect(unprotectSecret(secret)).toBe('sk-test-REDACTED-0000');
      expect(calls[0]).toMatchObject({ command: '/usr/bin/security', args: ['-i'] });
      expect(calls[0]!.stdin).toContain("'sk-test-REDACTED-0000'");
      expect(calls.flatMap((call) => call.args).join(' ')).not.toContain('sk-test-REDACTED-0000');
    } finally {
      restore();
    }
  });

  it('quotes apostrophes for security -i and rejects control characters', () => {
    let commandInput = '';
    const restore = configureSecretStoreRuntimeForTests({
      platform: 'darwin',
      runner: (_command, args, stdin) => {
        if (args[0] === '-i') commandInput = stdin ?? '';
        return { status: 0, stdout: args[0] === 'find-generic-password' ? "it's-safe\n" : '' };
      },
    });
    try {
      expect(protectSecret("it's-safe", 'quote-test').scheme).toBe('keychain');
      expect(commandInput).toContain("'it'\\''s-safe'");
      expect(() => protectSecret('not-safe\nkey', 'quote-test')).toThrow('control characters');
    } finally {
      restore();
    }
  });

  it('stores Linux keys on stdin and refuses when secret-tool/keyring is unavailable', () => {
    const calls: Array<{ command: string; args: readonly string[]; stdin?: string }> = [];
    const restore = configureSecretStoreRuntimeForTests({
      platform: 'linux',
      runner: (command, args, stdin) => {
        calls.push({ command, args, ...(stdin === undefined ? {} : { stdin }) });
        return { status: 0, stdout: args[0] === 'lookup' ? 'sk-test-REDACTED-0000\n' : '' };
      },
    });
    try {
      const secret = protectSecret('sk-test-REDACTED-0000', 'provider-b');
      expect(calls[0]?.command).toBe('secret-tool');
      expect(calls[0]?.args[0]).toBe('store');
      expect(calls[0]?.stdin).toBe('sk-test-REDACTED-0000');
      expect(calls.flatMap((call) => call.args).join(' ')).not.toContain('sk-test-REDACTED-0000');
      expect(unprotectSecret(secret)).toBe('sk-test-REDACTED-0000');
    } finally {
      restore();
    }

    const unavailable = configureSecretStoreRuntimeForTests({
      platform: 'linux',
      runner: () => ({ status: 1, stdout: '' }),
    });
    try {
      expect(() => protectSecret('sk-test-REDACTED-0000', 'provider-b')).toThrow(
        '--api-key-env <VAR>',
      );
      expect(() => protectSecret('sk-test-REDACTED-0000', 'provider-b')).toThrow(
        '--insecure-file-store',
      );
    } finally {
      unavailable();
    }
  });

  it('uses secret-tool clear for key deletion', () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const restore = configureSecretStoreRuntimeForTests({
      platform: 'linux',
      runner: (command, args) => {
        calls.push({ command, args });
        return { status: 0, stdout: '' };
      },
    });
    try {
      expect(
        deleteProtectedSecret({ scheme: 'libsecret', data: 'provider-x', account: 'provider-x' }),
      ).toBe(true);
      expect(calls[0]).toEqual({
        command: 'secret-tool',
        args: ['clear', 'service', 'joy-media', 'account', 'provider-x'],
      });
    } finally {
      restore();
    }
  });

  it('only writes the legacy file scheme with explicit opt-in and keeps mode 0600', () => {
    const restore = configureSecretStoreRuntimeForTests({
      platform: 'linux',
      runner: () => ({ status: 1, stdout: '' }),
    });
    const home = mkdtempSync(join(tmpdir(), 'joy-secret-file-'));
    const previousHome = process.env.HOME;
    const previousProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    expect(() => protectSecret('sk-test-REDACTED-0000')).toThrow('--api-key-env <VAR>');
    try {
      saveAiProviders({
        insecure: {
          apiKeyProtected: protectSecret('sk-test-REDACTED-0000', 'insecure', {
            insecureFileStore: true,
          }),
        },
      });
      const path = join(home, '.joy-media', 'ai-providers.json');
      expect(JSON.parse(readFileSync(path, 'utf8')).insecure.apiKeyProtected.scheme).toBe(
        'file-0600',
      );
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
      rmSync(home, { recursive: true, force: true });
      restore();
    }
  });

  it('migrates legacy plaintext only after keyring read-back succeeds', () => {
    const home = mkdtempSync(join(tmpdir(), 'joy-secret-migration-'));
    const previousHome = process.env.HOME;
    const previousProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const stored = new Map<string, string>();
    const runner: SecretStoreRunner = (_command, args, stdin) => {
      const account = args.at(-1)!;
      if (args[0] === 'store') {
        stored.set(account, stdin ?? '');
        return { status: 0, stdout: '' };
      }
      if (args[0] === 'lookup') return { status: 0, stdout: `${stored.get(account) ?? ''}\n` };
      return { status: 1, stdout: '' };
    };
    const restore = configureSecretStoreRuntimeForTests({ platform: 'linux', runner });
    try {
      writeFileSync(
        getAiProvidersPath(),
        JSON.stringify({
          legacy: { apiKey: 'sk-test-REDACTED-0000' },
          oldFileScheme: {
            apiKeyProtected: { scheme: 'file-0600', data: 'sk-test-REDACTED-0000' },
          },
        }),
      );
      const migrated = loadAiProviders();
      expect(migrated.legacy?.apiKey).toBeUndefined();
      expect(migrated.legacy?.apiKeyProtected?.scheme).toBe('libsecret');
      expect(migrated.oldFileScheme?.apiKeyProtected?.scheme).toBe('libsecret');
      const persisted = JSON.parse(readFileSync(getAiProvidersPath(), 'utf8'));
      expect(persisted.legacy.apiKey).toBeUndefined();
      expect(persisted.oldFileScheme.apiKeyProtected.scheme).toBe('libsecret');
      expect(JSON.stringify(persisted)).not.toContain('sk-test-REDACTED-0000');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
      rmSync(home, { recursive: true, force: true });
      restore();
    }

    const failing = configureSecretStoreRuntimeForTests({
      platform: 'linux',
      runner: vi.fn((_command, args) => ({ status: args[0] === 'store' ? 0 : 1, stdout: '' })),
    });
    try {
      const failedHome = mkdtempSync(join(tmpdir(), 'joy-secret-failure-'));
      process.env.HOME = failedHome;
      process.env.USERPROFILE = failedHome;
      writeFileSync(
        getAiProvidersPath(),
        JSON.stringify({ legacy: { apiKey: 'sk-test-REDACTED-0000' } }),
      );
      const unchanged = loadAiProviders();
      expect(unchanged.legacy?.apiKey).toBe('sk-test-REDACTED-0000');
      rmSync(failedHome, { recursive: true, force: true });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
      failing();
    }
  });
});
