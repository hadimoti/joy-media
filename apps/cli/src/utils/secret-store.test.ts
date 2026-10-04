import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protectSecret, unprotectSecret } from './secret-store.js';
import { saveAiProviders } from './config.js';
import { getAiProvidersPath, loadAiProviders } from './config.js';
import { vi } from 'vitest';

describe('CLI secret storage', () => {
  it('migrates a legacy plaintext provider key on first load', () => {
    const home = mkdtempSync(join(tmpdir(), 'joy-secret-migration-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    try {
      const path = getAiProvidersPath();
      writeFileSync(path, JSON.stringify({ legacy: { apiKey: 'sk-test-REDACTED-0000' } }), 'utf8');
      const loaded = loadAiProviders();
      expect(loaded.legacy?.apiKey).toBeUndefined();
      expect(loaded.legacy?.apiKeyProtected?.scheme).toBe(
        process.platform === 'win32' ? 'dpapi-user' : 'file-0600',
      );
      expect(unprotectSecret(loaded.legacy!.apiKeyProtected!)).toBe('sk-test-REDACTED-0000');
      expect(readFileSync(path, 'utf8')).not.toContain('sk-test-REDACTED-0000');
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform === 'win32')(
    'writes provider configuration with owner-only file mode',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'joy-secret-test-'));
      const previousHome = process.env.HOME;
      const previousProfile = process.env.USERPROFILE;
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      try {
        saveAiProviders({ test: { apiKeyProtected: protectSecret('sk-test-REDACTED-0000') } });
        const path = join(home, '.joy-media', 'ai-providers.json');
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(readFileSync(path, 'utf8')).not.toContain('sk-test-REDACTED-0000');
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousProfile;
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')('round trips a DPAPI protected secret', () => {
    const key = 'sk-test-REDACTED-0000';
    expect(unprotectSecret(protectSecret(key))).toBe(key);
  });
});
