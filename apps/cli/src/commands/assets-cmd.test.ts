import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { runCli } from '../cli.js';
import { resolveAssetLibraryDirectory } from './assets-cmd.js';

interface TestAsset {
  id: string;
  projectId: string;
  kind: 'image' | 'audio' | 'video';
  sha256: string;
  bytes: number;
  descriptor: { mimeType: string };
  tags: string[];
  createdAt: number;
  cloudBacked: boolean;
  relativePath: string;
  displayName: string;
  sortName: string;
}

const assets: TestAsset[] = [
  {
    id: 'joylib-image',
    projectId: '',
    kind: 'image',
    sha256: 'image',
    bytes: 12,
    descriptor: { mimeType: 'image/png' },
    tags: [],
    createdAt: 1,
    cloudBacked: false,
    relativePath: 'images/joylib-image',
    displayName: 'Cover',
    sortName: 'cover',
  },
  {
    id: 'joylib-audio',
    projectId: '',
    kind: 'audio',
    sha256: 'audio',
    bytes: 34,
    descriptor: { mimeType: 'audio/wav' },
    tags: [],
    createdAt: 2,
    cloudBacked: false,
    relativePath: 'audio/joylib-audio',
    displayName: 'Theme',
    sortName: 'theme',
  },
  {
    id: 'joylib-video',
    projectId: '',
    kind: 'video',
    sha256: 'video',
    bytes: 56,
    descriptor: { mimeType: 'video/mp4' },
    tags: [],
    createdAt: 3,
    cloudBacked: false,
    relativePath: 'video/joylib-video',
    displayName: 'Trailer',
    sortName: 'trailer',
  },
];

describe('assets CLI commands', () => {
  let library = '';
  let outsideDirectory = '';
  let libraryLink = '';
  const originalAssetLibrary = process.env.JOY_MEDIA_ASSET_LIBRARY;

  afterEach(() => {
    if (originalAssetLibrary === undefined) delete process.env.JOY_MEDIA_ASSET_LIBRARY;
    else process.env.JOY_MEDIA_ASSET_LIBRARY = originalAssetLibrary;
    if (libraryLink) {
      try {
        lstatSync(libraryLink);
        rmdirSync(libraryLink);
      } catch {
        // The junction may already be gone.
      }
    }
    if (library) rmSync(library, { recursive: true, force: true });
    if (outsideDirectory) rmSync(outsideDirectory, { recursive: true, force: true });
    library = '';
    libraryLink = '';
    outsideDirectory = '';
    vi.restoreAllMocks();
  });

  function createLibrary(entries = assets): string {
    library = mkdtempSync(join(tmpdir(), 'joy-assets-cli-'));
    for (const asset of entries) {
      const relativePath = relative(library, join(library, asset.relativePath));
      const pathStaysInside =
        !isAbsolute(asset.relativePath) &&
        relativePath !== '..' &&
        !relativePath.startsWith(`..${sep}`) &&
        !isAbsolute(relativePath);
      if (asset.id !== 'joylib-video' && pathStaysInside) {
        const filePath = join(library, asset.relativePath);
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, 'asset');
      }
    }
    writeFileSync(
      join(library, 'catalog.json'),
      JSON.stringify({ version: 1, counts: { total: entries.length }, assets: entries }),
    );
    return library;
  }

  function captureOutput() {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values) => stdout.push(values.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...values) => stderr.push(values.join(' ')));
    return { stdout, stderr };
  }

  it('lists only entries matching the requested kind', async () => {
    const dir = createLibrary();
    const output = captureOutput();
    const exitCode = await runCli([
      'assets',
      'list',
      '--kind',
      'audio',
      '--library',
      dir,
      '--json',
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.stdout.join('\n'))).toEqual([
      expect.objectContaining({ id: 'joylib-audio' }),
    ]);
  });

  it('shows an entry with its absolute path and file existence', async () => {
    const dir = createLibrary();
    const output = captureOutput();
    const exitCode = await runCli(['assets', 'show', 'joylib-image', '--library', dir, '--json']);

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.stdout.join('\n'))).toMatchObject({
      id: 'joylib-image',
      absolutePath: join(dir, 'images', 'joylib-image'),
      fileExists: true,
    });
  });

  it('prints only the absolute path for path and reports unknown ids', async () => {
    const dir = createLibrary();
    const pathOutput = captureOutput();
    expect(await runCli(['assets', 'path', 'joylib-audio', '--library', dir])).toBe(0);
    expect(pathOutput.stdout).toEqual([join(dir, 'audio', 'joylib-audio')]);

    const unknownOutput = captureOutput();
    expect(await runCli(['assets', 'path', 'JOYLIB-audio', '--library', dir])).toBe(1);
    expect(unknownOutput.stderr.join('\n')).toContain('Unknown asset id');
  });

  it('treats a missing catalog as an empty library', async () => {
    library = mkdtempSync(join(tmpdir(), 'joy-assets-empty-'));
    const output = captureOutput();
    expect(await runCli(['assets', 'list', '--library', library, '--json'])).toBe(0);
    expect(output.stdout).toEqual(['[]']);
  });

  it('returns a machine-readable error for an invalid catalog', async () => {
    library = mkdtempSync(join(tmpdir(), 'joy-assets-invalid-'));
    writeFileSync(join(library, 'catalog.json'), '{');
    const output = captureOutput();
    expect(await runCli(['assets', 'list', '--library', library, '--json'])).toBe(1);
    expect(JSON.parse(output.stdout.join('\n'))).toMatchObject({ code: 'invalid_catalog' });

    writeFileSync(join(library, 'catalog.json'), JSON.stringify({ version: 1 }));
    const missingAssetsOutput = captureOutput();
    expect(await runCli(['assets', 'list', '--library', library, '--json'])).toBe(1);
    expect(JSON.parse(missingAssetsOutput.stdout.join('\n'))).toMatchObject({
      code: 'invalid_catalog',
      error: 'Asset catalog must contain an assets array.',
    });
  });

  it('omits entries whose relative path escapes the library', async () => {
    const escapingAsset = { ...assets[0]!, relativePath: '../outside' };
    const dir = createLibrary([escapingAsset]);
    const output = captureOutput();
    expect(await runCli(['assets', 'list', '--library', dir, '--json'])).toBe(0);
    expect(JSON.parse(output.stdout.join('\n'))).toEqual([]);
    expect(output.stderr.join('\n')).toContain('escapes the asset library');
  });

  it('refuses traversal paths for show and path without creating the outside file', async () => {
    const outsideName = `escape-${randomUUID()}`;
    const escapingAsset = { ...assets[0]!, relativePath: `../${outsideName}` };
    const dir = createLibrary([escapingAsset]);
    const outsideFile = join(tmpdir(), outsideName);
    expect(existsSync(outsideFile)).toBe(false);

    for (const action of ['show', 'path']) {
      const output = captureOutput();
      expect(await runCli(['assets', action, escapingAsset.id, '--library', dir])).toBe(1);
      expect(output.stderr.join('\n')).toContain('escapes the asset library');
    }
    expect(existsSync(outsideFile)).toBe(false);
  });

  it('omits absolute paths from list and refuses them in show without creating a file', async () => {
    const absoluteDirectory = `absolute-outside-${randomUUID()}`;
    const absolutePath = join(tmpdir(), absoluteDirectory, 'file');
    const absoluteAsset = { ...assets[0]!, relativePath: absolutePath };
    const dir = createLibrary([absoluteAsset]);
    const output = captureOutput();

    expect(await runCli(['assets', 'list', '--library', dir, '--json'])).toBe(0);
    expect(JSON.parse(output.stdout.join('\n'))).toEqual([]);
    expect(output.stderr.join('\n')).toContain('escapes the asset library');
    const showOutput = captureOutput();
    expect(await runCli(['assets', 'show', absoluteAsset.id, '--library', dir])).toBe(1);
    expect(showOutput.stderr.join('\n')).toContain('escapes the asset library');
    expect(existsSync(absolutePath)).toBe(false);
    expect(existsSync(join(tmpdir(), absoluteDirectory))).toBe(false);
  });

  it('refuses paths through a junction that points outside the library', async () => {
    outsideDirectory = mkdtempSync(join(tmpdir(), 'joy-assets-outside-'));
    writeFileSync(join(outsideDirectory, 'joylib-linked'), 'asset');
    const linkedAsset = { ...assets[0]!, relativePath: 'images/linked/joylib-linked' };
    const dir = createLibrary([]);
    mkdirSync(join(dir, 'images'), { recursive: true });
    libraryLink = join(dir, 'images', 'linked');
    symlinkSync(outsideDirectory, libraryLink, 'junction');
    writeFileSync(
      join(dir, 'catalog.json'),
      JSON.stringify({ version: 1, counts: { total: 1 }, assets: [linkedAsset] }),
    );

    const listOutput = captureOutput();
    expect(await runCli(['assets', 'list', '--library', dir, '--json'])).toBe(0);
    expect(JSON.parse(listOutput.stdout.join('\n'))).toEqual([]);
    expect(listOutput.stderr.join('\n')).toContain('escapes the asset library');
    for (const action of ['show', 'path']) {
      const output = captureOutput();
      expect(await runCli(['assets', action, linkedAsset.id, '--library', dir])).toBe(1);
      expect(output.stderr.join('\n')).toContain('escapes the asset library');
    }
    expect(existsSync(join(outsideDirectory, 'joylib-linked'))).toBe(true);
  });

  it('omits dangling junction paths and refuses them in show and path', async () => {
    outsideDirectory = mkdtempSync(join(tmpdir(), 'joy-assets-outside-'));
    const danglingAsset = { ...assets[0]!, relativePath: 'images/dangling/joylib-dangling' };
    const dir = createLibrary([]);
    mkdirSync(join(dir, 'images'), { recursive: true });
    libraryLink = join(dir, 'images', 'dangling');
    symlinkSync(outsideDirectory, libraryLink, 'junction');
    rmSync(outsideDirectory, { recursive: true, force: true });
    writeFileSync(
      join(dir, 'catalog.json'),
      JSON.stringify({ version: 1, counts: { total: 1 }, assets: [danglingAsset] }),
    );

    const listOutput = captureOutput();
    expect(await runCli(['assets', 'list', '--library', dir, '--json'])).toBe(0);
    expect(JSON.parse(listOutput.stdout.join('\n'))).toEqual([]);
    expect(listOutput.stderr.join('\n')).toContain('escapes the asset library');
    for (const action of ['show', 'path']) {
      const output = captureOutput();
      expect(await runCli(['assets', action, danglingAsset.id, '--library', dir])).toBe(1);
      expect(output.stderr.join('\n')).toContain('escapes the asset library');
    }
  });

  it('resolves --library before the environment and default directory', () => {
    process.env.JOY_MEDIA_ASSET_LIBRARY = 'environment-library';
    expect(resolveAssetLibraryDirectory('flag-library', 'test-home')).toBe('flag-library');
    expect(resolveAssetLibraryDirectory(undefined, 'test-home')).toBe('environment-library');
    process.env.JOY_MEDIA_ASSET_LIBRARY = '';
    expect(resolveAssetLibraryDirectory(undefined, 'test-home')).toBe(
      join('test-home', 'joy-media-assets'),
    );
    delete process.env.JOY_MEDIA_ASSET_LIBRARY;
    expect(resolveAssetLibraryDirectory(undefined, 'test-home')).toBe(
      join('test-home', 'joy-media-assets'),
    );
    expect(resolveAssetLibraryDirectory()).toBe(join(homedir(), 'joy-media-assets'));
  });

  it('uses the --library directory ahead of the environment directory', async () => {
    const flagDirectory = createLibrary();
    const environmentDirectory = join(flagDirectory, 'environment-library');
    mkdirSync(environmentDirectory);
    writeFileSync(join(environmentDirectory, 'catalog.json'), JSON.stringify({ assets: [] }));
    process.env.JOY_MEDIA_ASSET_LIBRARY = environmentDirectory;

    const flagOutput = captureOutput();
    expect(await runCli(['assets', 'list', '--library', flagDirectory, '--json'])).toBe(0);
    expect(JSON.parse(flagOutput.stdout.join('\n'))).toHaveLength(3);

    const environmentOutput = captureOutput();
    expect(await runCli(['assets', 'list', '--json'])).toBe(0);
    expect(JSON.parse(environmentOutput.stdout.join('\n'))).toEqual([]);
  });

  it('keeps a missing media file listed and reports fileExists false in show', async () => {
    const dir = createLibrary();
    const output = captureOutput();
    expect(await runCli(['assets', 'list', '--library', dir, '--json'])).toBe(0);
    expect(JSON.parse(output.stdout.shift()!)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'joylib-video', fileExists: false })]),
    );
    output.stdout.length = 0;
    expect(await runCli(['assets', 'show', 'joylib-video', '--library', dir, '--json'])).toBe(0);
    const entry = JSON.parse(output.stdout.join('\n'));
    expect(entry.fileExists).toBe(false);
    expect(existsSync(entry.absolutePath)).toBe(false);
  });
});
