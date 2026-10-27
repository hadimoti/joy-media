import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseReleaseManifest } from '../../../packages/release-trust/src/manifest.ts';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'build-release-manifest.mjs');
const ISSUED = '2026-10-28T12:00:00Z';
const SETUP = 'joy-media-setup.exe';
const ZIP = 'joy-media-windows-x64-v1.0.3.zip';
const SETUP_BYTES = Buffer.from('setup bytes for the build test\n', 'utf8');
const ZIP_BYTES = Buffer.from('archive bytes for the build test\n', 'utf8');

interface ManifestInput {
  readonly out: string;
  readonly channel?: string;
  readonly version?: string;
  readonly issuedAt?: string;
  readonly files?: readonly string[];
  readonly extra?: readonly string[];
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'build-release-manifest-'));
  writeFileSync(join(directory, SETUP), SETUP_BYTES);
  writeFileSync(join(directory, ZIP), ZIP_BYTES);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifestArgs(input: ManifestInput): string[] {
  const files = input.files ?? [SETUP, ZIP];
  return [
    '--release-dir',
    directory,
    '--version',
    input.version ?? '1.0.3',
    '--channel',
    input.channel ?? 'stable',
    '--issued-at',
    input.issuedAt ?? ISSUED,
    ...files.flatMap((name) => ['--file', name]),
    ...(input.extra ?? []),
    '--out',
    input.out,
  ];
}

function build(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

describe('release manifest builder', () => {
  it('writes the schema the shipped verifier accepts, with the files sorted by name', () => {
    const out = join(directory, 'release-manifest.json');
    const result = build(manifestArgs({ out, files: [ZIP, SETUP] }));
    expect(result.status).toBe(0);

    const bytes = readFileSync(out);
    // parseReleaseManifest is the parser the desktop app and `joy-media update verify` use. It refuses an unknown key.
    expect(parseReleaseManifest(bytes)).toEqual({
      channel: 'stable',
      version: '1.0.3',
      issuedAt: ISSUED,
      files: [
        { name: SETUP, size: SETUP_BYTES.length, sha256: sha256(SETUP_BYTES) },
        { name: ZIP, size: ZIP_BYTES.length, sha256: sha256(ZIP_BYTES) },
      ],
    });
    expect(Object.keys(JSON.parse(bytes.toString('utf8')))).toEqual([
      'channel',
      'version',
      'issuedAt',
      'files',
    ]);
  });

  it('writes the same bytes for the same inputs, and names a minimum version only when one is given', () => {
    const first = join(directory, 'first.json');
    const second = join(directory, 'second.json');
    expect(build(manifestArgs({ out: first, extra: ['--min-supported', '1.0.2'] })).status).toBe(0);
    expect(
      build(manifestArgs({ out: second, files: [ZIP, SETUP], extra: ['--min-supported', '1.0.2'] }))
        .status,
    ).toBe(0);
    expect(readFileSync(first)).toEqual(readFileSync(second));
    expect(parseReleaseManifest(readFileSync(first)).minSupportedVersion).toBe('1.0.2');

    const plain = join(directory, 'plain.json');
    expect(build(manifestArgs({ out: plain })).status).toBe(0);
    expect(parseReleaseManifest(readFileSync(plain)).minSupportedVersion).toBeUndefined();
  });

  it.each<[string, ManifestInput, RegExp]>([
    ['a path-like file name', { out: '', files: ['../escape.exe'] }, /not a plain file name/u],
    ['a channel the verifier does not know', { out: '', channel: 'nightly' }, /stable or beta/u],
    [
      'an issue time that is not UTC',
      { out: '', issuedAt: '2026-10-28T12:00:00+03:30' },
      /--issued-at must be a UTC time/u,
    ],
    ['a version with a leading zero', { out: '', version: '01.0.3' }, /semantic version/u],
    ['a file listed twice', { out: '', files: [SETUP, SETUP] }, /listed twice/u],
    [
      'a file that is not in the folder',
      { out: '', files: ['missing.exe'] },
      /missing from the release folder/u,
    ],
    ['an empty file', { out: '', files: ['empty.exe'] }, /size the manifest refuses/u],
    ['an unknown option', { out: '', extra: ['--sign', 'yes'] }, /unknown option: --sign/u],
  ])('refuses %s and writes nothing', (_label, input, message) => {
    writeFileSync(join(directory, 'empty.exe'), '');
    const out = join(directory, 'refused.json');
    const result = build(manifestArgs({ ...input, out }));
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(message);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses to overwrite an output that already exists', () => {
    const out = join(directory, 'release-manifest.json');
    writeFileSync(out, 'kept\n');
    const result = build(manifestArgs({ out }));
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/refusing to overwrite/u);
    expect(readFileSync(out, 'utf8')).toBe('kept\n');
  });
});
