import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkerEntry } from './worker-entry.js';

const mainDirname = join('C:', 'app', 'dist', 'main');
const execPath = join('C:', 'node', 'node.exe');

describe('resolveWorkerEntry', () => {
  it('targets the packaged/unpacked sibling worker entry when it exists', () => {
    const unpackedEntry = join(mainDirname, '..', '..', 'worker', 'index.js');
    const result = resolveWorkerEntry({
      mainDirname,
      execPath,
      fileExists: (path) => path === unpackedEntry,
    });
    expect(result).toEqual({ command: execPath, args: [unpackedEntry] });
  });

  it('targets the repo-layout compiled worker entry when the unpacked one is absent', () => {
    const compiledEntry = join(mainDirname, '..', '..', '..', 'worker', 'dist', 'index.js');
    const result = resolveWorkerEntry({
      mainDirname,
      execPath,
      fileExists: (path) => path === compiledEntry,
    });
    expect(result).toEqual({ command: execPath, args: [compiledEntry] });
  });

  it('prefers the packaged/unpacked entry over the repo-layout compiled one', () => {
    const unpackedEntry = join(mainDirname, '..', '..', 'worker', 'index.js');
    const compiledEntry = join(mainDirname, '..', '..', '..', 'worker', 'dist', 'index.js');
    const result = resolveWorkerEntry({
      mainDirname,
      execPath,
      fileExists: (path) => path === unpackedEntry || path === compiledEntry,
    });
    expect(result).toEqual({ command: execPath, args: [unpackedEntry] });
  });

  it('falls back to running src/index.ts through tsx when nothing is compiled', () => {
    const workerRoot = join(mainDirname, '..', '..', '..', 'worker');
    const tsxCli = join(workerRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const devEntry = join(workerRoot, 'src', 'index.ts');
    const result = resolveWorkerEntry({ mainDirname, execPath, fileExists: () => false });
    expect(result).toEqual({ command: execPath, args: [tsxCli, devEntry] });
  });
});
