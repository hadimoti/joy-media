import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliFlags } from '../cli.js';
import { handleUpdateCommand, type UpdateDeps } from './update-cmd.js';

interface TestKey {
  readonly privateKey: KeyObject;
  readonly publicPem: string;
}

function testKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

const workDirs: string[] = [];

afterEach(() => {
  for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'joy-update-cmd-'));
  workDirs.push(dir);
  return dir;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Writes a release file, its signed manifest and the signature beside it, as the release publishes them. */
function publishRelease(
  dir: string,
  signer: TestKey,
  content: Buffer,
  version = '1.0.3',
): { readonly manifest: Buffer; readonly signature: string } {
  const manifest = Buffer.from(
    JSON.stringify({
      channel: 'stable',
      version,
      issuedAt: '2026-10-26T00:00:00Z',
      files: [{ name: 'joy-media-setup.exe', size: content.length, sha256: sha256(content) }],
    }),
  );
  const signature = sign(null, manifest, signer.privateKey).toString('base64url');
  writeFileSync(join(dir, 'joy-media-setup.exe'), content);
  writeFileSync(join(dir, 'release-manifest.json'), manifest);
  writeFileSync(join(dir, 'release-manifest.json.sig'), `${signature}\n`);
  return { manifest, signature };
}

function makeDeps(partial: Partial<UpdateDeps> = {}): {
  readonly deps: UpdateDeps;
  readonly lines: string[];
  readonly json: unknown[];
} {
  const lines: string[] = [];
  const json: unknown[] = [];
  const deps: UpdateDeps = {
    publicKeysPem: [],
    fetch: globalThis.fetch,
    installRoot: join(tmpdir(), 'joy-no-such-install'),
    installedVersion: '1.0.2',
    out: (text) => lines.push(text),
    printJson: (value) => json.push(value),
    ...partial,
  };
  return { deps, lines, json };
}

const JSON_FLAGS = { json: true } as CliFlags;

describe('joy-media update verify', () => {
  it('accepts a file that matches the signed manifest', async () => {
    const dir = workDir();
    const key = testKey();
    publishRelease(dir, key, Buffer.from('installer bytes'));
    const { deps, json } = makeDeps({ publicKeysPem: [key.publicPem] });
    const code = await handleUpdateCommand(
      ['verify', join(dir, 'joy-media-setup.exe')],
      JSON_FLAGS,
      deps,
    );
    expect(code).toBe(0);
    expect(json[0]).toMatchObject({ ok: true, status: 'verified', version: '1.0.3' });
  });

  it('refuses a file that changed after it was signed', async () => {
    const dir = workDir();
    const key = testKey();
    publishRelease(dir, key, Buffer.from('installer bytes'));
    writeFileSync(join(dir, 'joy-media-setup.exe'), Buffer.from('tampered bytes'));
    const { deps, json } = makeDeps({ publicKeysPem: [key.publicPem] });
    const code = await handleUpdateCommand(
      ['verify', join(dir, 'joy-media-setup.exe')],
      JSON_FLAGS,
      deps,
    );
    expect(code).toBe(1);
    expect(json[0]).toMatchObject({ ok: false, status: 'size-mismatch' });
  });

  it('refuses a file of the same size but different bytes', async () => {
    const dir = workDir();
    const key = testKey();
    publishRelease(dir, key, Buffer.from('aaaa'));
    writeFileSync(join(dir, 'joy-media-setup.exe'), Buffer.from('bbbb'));
    const { deps, json } = makeDeps({ publicKeysPem: [key.publicPem] });
    const code = await handleUpdateCommand(
      ['verify', join(dir, 'joy-media-setup.exe')],
      JSON_FLAGS,
      deps,
    );
    expect(code).toBe(1);
    expect(json[0]).toMatchObject({ ok: false, status: 'digest-mismatch' });
  });

  it('refuses a manifest signed by a key that is not trusted', async () => {
    const dir = workDir();
    const trusted = testKey();
    const attacker = testKey();
    publishRelease(dir, attacker, Buffer.from('installer bytes'));
    const { deps, json } = makeDeps({ publicKeysPem: [trusted.publicPem] });
    const code = await handleUpdateCommand(
      ['verify', join(dir, 'joy-media-setup.exe')],
      JSON_FLAGS,
      deps,
    );
    expect(code).toBe(1);
    expect(json[0]).toMatchObject({ ok: false, status: 'signature-invalid' });
  });

  it('refuses everything when this build trusts no key', async () => {
    const dir = workDir();
    const key = testKey();
    publishRelease(dir, key, Buffer.from('installer bytes'));
    const { deps, json } = makeDeps({ publicKeysPem: [] });
    const code = await handleUpdateCommand(
      ['verify', join(dir, 'joy-media-setup.exe')],
      JSON_FLAGS,
      deps,
    );
    expect(code).toBe(1);
    expect(json[0]).toMatchObject({ ok: false, status: 'release-key-unconfigured' });
  });

  it('refuses a file the signed manifest does not list', async () => {
    const dir = workDir();
    const key = testKey();
    publishRelease(dir, key, Buffer.from('installer bytes'));
    writeFileSync(join(dir, 'stray.exe'), Buffer.from('installer bytes'));
    const { deps, json } = makeDeps({ publicKeysPem: [key.publicPem] });
    const code = await handleUpdateCommand(['verify', join(dir, 'stray.exe')], JSON_FLAGS, deps);
    expect(code).toBe(1);
    expect(json[0]).toMatchObject({ ok: false, status: 'not-listed' });
  });

  it('reports a usage error when no file is given', async () => {
    const { deps } = makeDeps();
    expect(await handleUpdateCommand(['verify'], undefined, deps)).toBe(2);
  });
});

describe('joy-media update check', () => {
  it('makes no request when this build trusts no key', async () => {
    const fetchFn = vi.fn(globalThis.fetch);
    const { deps, json } = makeDeps({ fetch: fetchFn });
    const code = await handleUpdateCommand(['check'], JSON_FLAGS, deps);
    expect(code).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(json[0]).toMatchObject({ ok: false, status: 'release-key-unconfigured' });
  });

  it('reports a newer signed release with the link to its release page', async () => {
    const key = testKey();
    const scratch = workDir();
    const { manifest, signature } = publishRelease(scratch, key, Buffer.from('x'), '1.0.3');
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.endsWith('.sig') ? Buffer.from(`${signature}\n`) : manifest;
      return {
        ok: true,
        status: 200,
        url,
        headers: new Headers(),
        arrayBuffer: async () =>
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const { deps, lines } = makeDeps({ publicKeysPem: [key.publicPem], fetch: fetchFn });
    const code = await handleUpdateCommand(['check'], undefined, deps);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('https://github.com/hadimoti/joy-media/releases/tag/v1.0.3');
  });

  it('refuses when the release host cannot be reached', async () => {
    const key = testKey();
    const fetchFn = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const { deps, json } = makeDeps({ publicKeysPem: [key.publicPem], fetch: fetchFn });
    const code = await handleUpdateCommand(['check'], JSON_FLAGS, deps);
    expect(code).toBe(1);
    expect(json[0]).toMatchObject({ ok: false, status: 'network-unavailable' });
  });
});

describe('joy-media update rollback', () => {
  it('says there is nothing to roll back to when no kept version is on disk', async () => {
    const { deps, json } = makeDeps({ installRoot: workDir() });
    const code = await handleUpdateCommand(['rollback'], JSON_FLAGS, deps);
    expect(code).toBe(1);
    expect(json[0]).toMatchObject({ ok: false, status: 'no-kept-previous' });
  });

  it('shows the installer command and moves nothing', async () => {
    const root = join(workDir(), 'JOY Media');
    const previous = `${root}.previous`;
    mkdirSync(join(root, 'resources', 'app'), { recursive: true });
    mkdirSync(join(previous, 'resources', 'app'), { recursive: true });
    writeFileSync(
      join(root, 'resources', 'app', 'package.json'),
      JSON.stringify({ version: '1.0.3' }),
    );
    writeFileSync(
      join(previous, 'resources', 'app', 'package.json'),
      JSON.stringify({ version: '1.0.2' }),
    );
    writeFileSync(join(previous, 'joy-media.exe'), 'kept');
    const { deps, json } = makeDeps({ installRoot: root, installedVersion: '1.0.3' });
    const code = await handleUpdateCommand(['rollback'], JSON_FLAGS, deps);
    expect(code).toBe(0);
    expect(json[0]).toMatchObject({ ok: true, status: 'rollback-available', keptVersion: '1.0.2' });
    expect(String((json[0] as { message: string }).message)).toContain(
      'joy-media-setup.exe /rollback',
    );
    expect(existsSync(root)).toBe(true);
    expect(existsSync(previous)).toBe(true);
  });
});

describe('joy-media update command shape', () => {
  it('reports a usage error for an unknown subcommand', async () => {
    const { deps } = makeDeps();
    expect(await handleUpdateCommand(['install'], undefined, deps)).toBe(2);
  });
});
