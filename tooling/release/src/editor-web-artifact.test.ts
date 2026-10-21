import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const CLI_PATH = join(HERE, 'editor-web-artifact.mjs');
const CANDIDATE_SHA = 'a'.repeat(40);

interface Fixture {
  readonly root: string;
  readonly dist: string;
  readonly lockfile: string;
  readonly manifest: string;
}

function withFixture<T>(fn: (fixture: Fixture) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'joy-media-editor-web-artifact-'));
  const fixture: Fixture = {
    root,
    dist: join(root, 'dist'),
    lockfile: join(root, 'pnpm-lock.yaml'),
    manifest: join(root, 'manifest.json'),
  };
  mkdirSync(join(fixture.dist, 'assets'), { recursive: true });
  writeFileSync(join(fixture.dist, 'index.html'), '<!doctype html><title>JOY</title>\n');
  writeFileSync(join(fixture.dist, 'assets', 'main.js'), 'globalThis.joyMedia = true;\n');
  writeFileSync(fixture.lockfile, 'lockfileVersion: 9.0\nsettings: {}\n');
  try {
    return fn(fixture);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function invoke(mode: 'create' | 'verify', fixture: Fixture, candidateSha = CANDIDATE_SHA) {
  return spawnSync(
    process.execPath,
    [
      CLI_PATH,
      mode,
      '--candidate-sha',
      candidateSha,
      '--lockfile',
      fixture.lockfile,
      '--dist',
      fixture.dist,
      '--manifest',
      fixture.manifest,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true },
  );
}

function expectSuccess(result: ReturnType<typeof invoke>): void {
  expect(result.error?.message ?? result.stderr, 'artifact helper should succeed').toBe('');
  expect(result.status, result.stderr).toBe(0);
}

function expectRejected(result: ReturnType<typeof invoke>): void {
  expect(result.status, 'mismatched or modified artifact must fail verification').not.toBe(0);
}

describe('source-bound editor web artifact helper', () => {
  it('creates and verifies a canonical manifest for every renderer file', () => {
    withFixture((fixture) => {
      expect(existsSync(CLI_PATH)).toBe(true);
      expectSuccess(invoke('create', fixture));

      const manifest = JSON.parse(readFileSync(fixture.manifest, 'utf8')) as {
        schemaVersion: number;
        candidateSha: string;
        lockfileSha256: string;
        files: Array<{ path: string; sizeBytes: number; sha256: string }>;
      };
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.candidateSha).toBe(CANDIDATE_SHA);
      expect(manifest.lockfileSha256).toBe(
        createHash('sha256').update(readFileSync(fixture.lockfile)).digest('hex'),
      );
      expect(manifest.files.map((file) => file.path)).toEqual(['assets/main.js', 'index.html']);
      expect(
        manifest.files.every((file) => file.sizeBytes > 0 && /^[0-9a-f]{64}$/.test(file.sha256)),
      ).toBe(true);
      expectSuccess(invoke('verify', fixture));
    });
  });

  it('rejects a different candidate SHA or lockfile', () => {
    withFixture((fixture) => {
      expectSuccess(invoke('create', fixture));
      expectRejected(invoke('verify', fixture, 'b'.repeat(40)));

      writeFileSync(
        fixture.lockfile,
        'lockfileVersion: 9.0\nsettings: { autoInstallPeers: false }\n',
      );
      expectRejected(invoke('verify', fixture));
    });
  });

  it('rejects changed, missing, or extra files in the transferred renderer tree', () => {
    withFixture((fixture) => {
      const mainFile = join(fixture.dist, 'assets', 'main.js');
      const original = readFileSync(mainFile, 'utf8');
      expectSuccess(invoke('create', fixture));

      writeFileSync(mainFile, `${original}// changed\n`);
      expectRejected(invoke('verify', fixture));

      writeFileSync(mainFile, original);
      writeFileSync(join(fixture.dist, 'extra.txt'), 'unexpected\n');
      expectRejected(invoke('verify', fixture));

      rmSync(join(fixture.dist, 'extra.txt'));
      rmSync(mainFile);
      expectRejected(invoke('verify', fixture));
    });
  });
});
