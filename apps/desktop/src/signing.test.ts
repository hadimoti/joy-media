import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error The release hook is intentionally JavaScript so electron-builder can load it directly.
import { signExecutableFiles, signingConfiguration } from '../scripts/sign-windows-artifacts.mjs';

describe('Windows release signing', () => {
  it('requires signing configuration and an HTTPS timestamp', () => {
    expect(() => signingConfiguration({})).toThrow(/Refusing unsigned release/);
    expect(() =>
      signingConfiguration({
        JOY_SIGNTOOL_PATH: 'signtool.exe',
        JOY_SIGNING_CERT_THUMBPRINT: 'test-thumbprint',
        JOY_SIGNING_TIMESTAMP_URL: 'http://timestamp.example.test',
      }),
    ).toThrow(/HTTPS/);
  });

  it('signs every executable under the installed app output', () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-desktop-signing-'));
    const nested = join(root, 'resources', 'helper');
    mkdirSync(nested, { recursive: true });
    const main = join(root, 'JOY Media.exe');
    const helper = join(nested, 'helper.exe');
    writeFileSync(main, 'main');
    writeFileSync(helper, 'helper');
    const run = vi.fn<(file: string, args: readonly string[]) => { status: number }>(() => ({
      status: 0,
    }));
    const verify = vi.fn(() => true);
    const files = signExecutableFiles(root, {
      config: {
        signtool: 'signtool.exe',
        thumbprint: 'test-thumbprint',
        timestamp: 'https://timestamp.example.test',
      },
      run,
      verify,
    });
    expect(files).toHaveLength(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[1]).toContain('SHA256');
  });
});
