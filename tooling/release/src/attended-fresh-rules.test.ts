import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FRESH_PROCESS_SCENARIO } from './attended-fresh-process.ts';
import {
  approvedOwnerFilesOf,
  countFiles,
  findOnPath,
  folderSignature,
  linkInside,
  linkOnPath,
  reportWithChanges,
  reportWithFolderChanges,
  runFolderProblem,
  unexpectedRunArtifacts,
  ownerLibraryRefusal,
  parseRunArgs,
} from '../attended/scenario-rules.mjs';

const CANDIDATE = 'ded976c8b4fe10c0316e5071ece535ba181707e9';
const HASH = 'd1e7e6978ef4ae5a118580bd016461d2169213f88393c4002041dd7bd9cddbc1';
const SCENARIOS = ['desktop.app.restart-save-export', FRESH_PROCESS_SCENARIO];

function freshArgs(extra: string[] = []): string[] {
  return [
    '--scenario',
    FRESH_PROCESS_SCENARIO,
    '--exe',
    'C:\\run\\app\\joy-media.exe',
    '--candidate',
    CANDIDATE,
    '--expected-exe-sha256',
    HASH,
    '--library',
    'C:\\run\\library',
    '--out',
    'C:\\run\\fresh-1',
    ...extra,
  ];
}

describe('the fresh-process command line', () => {
  it('takes no source profile, no project and no profile folder', () => {
    const options = parseRunArgs(freshArgs(), SCENARIOS);
    expect(options.scenario).toBe(FRESH_PROCESS_SCENARIO);
    expect(options.profile).toBeUndefined();
    expect(options.project).toBeUndefined();
    expect(options.launch).toBe(false);
  });

  it('refuses a missing library, and accepts --launch and --media', () => {
    const args = freshArgs();
    const at = args.indexOf('--library');
    const withoutLibrary = [...args.slice(0, at), ...args.slice(at + 2)];
    expect(() => parseRunArgs(withoutLibrary, SCENARIOS)).toThrow('--library is required');
    const launched = parseRunArgs(
      freshArgs(['--launch', '--media', 'C:\\clip.mp4', '--owner-library-files', '3221']),
      SCENARIOS,
    );
    expect(launched.launch).toBe(true);
    expect(launched.media).toBe('C:\\clip.mp4');
  });

  it('refuses a launch that approves no owner library count, and allows a dry run without one', () => {
    expect(() => parseRunArgs(freshArgs(['--launch']), SCENARIOS)).toThrow(
      '--owner-library-files is required with --launch',
    );
    expect(parseRunArgs(freshArgs(), SCENARIOS).launch).toBe(false);
  });

  it('still requires the restart scenario its source profile', () => {
    const args = [
      '--scenario',
      'desktop.app.restart-save-export',
      '--exe',
      'C:\\run\\app\\joy-media.exe',
      '--candidate',
      CANDIDATE,
      '--expected-exe-sha256',
      HASH,
      '--library',
      'C:\\run\\library',
      '--out',
      'C:\\run\\restart-1',
      '--profile',
      'C:\\run\\profile',
    ];
    expect(() => parseRunArgs(args, SCENARIOS)).toThrow('--profile-source is required');
  });

  it('refuses an option the scenario does not take, and an option given twice', () => {
    expect(() => parseRunArgs(freshArgs(['--owner-library-file', '3221']), SCENARIOS)).toThrow(
      'unknown option --owner-library-file',
    );
    expect(() => parseRunArgs(freshArgs(['--profile', 'C:\\run\\profile']), SCENARIOS)).toThrow(
      'unknown option --profile',
    );
    expect(() => parseRunArgs(freshArgs(['--project', 'project-1']), SCENARIOS)).toThrow(
      'unknown option --project',
    );
    expect(() =>
      parseRunArgs(
        freshArgs(['--owner-library-files', '3221', '--owner-library-files', '3222']),
        SCENARIOS,
      ),
    ).toThrow('--owner-library-files is given more than once');
  });
});

describe('the launch folder rule', () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'fresh-run-'));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('allows only an empty run folder, and refuses every file an earlier attempt left', () => {
    expect(unexpectedRunArtifacts(folder)).toEqual([]);
    expect(unexpectedRunArtifacts(join(folder, 'missing'))).toEqual([]);
    writeFileSync(join(folder, 'preflight.json'), '{}');
    mkdirSync(join(folder, 'plan-source'));
    expect(unexpectedRunArtifacts(folder).sort()).toEqual(['plan-source', 'preflight.json']);
  });

  it('refuses a folder that is a file or a link, instead of reading it as empty', () => {
    const file = join(folder, 'a-file');
    writeFileSync(file, '');
    expect(unexpectedRunArtifacts(file)).toEqual(['a file (not a folder)']);
    expect(unexpectedRunArtifacts(join(file, 'inside'))).toEqual(['a file (not a folder)']);
    const target = join(folder, 'target');
    const link = join(folder, 'link');
    mkdirSync(target);
    symlinkSync(target, link, 'junction');
    rmSync(target, { recursive: true, force: true });
    expect(unexpectedRunArtifacts(link)).toEqual(['a link (not a folder)']);
    expect(unexpectedRunArtifacts(join(link, 'missing'))).toEqual(['a link (not a folder)']);
  });

  it('finds a link or a junction anywhere on a run path, and not on a plain one', () => {
    const target = join(folder, 'target');
    const link = join(folder, 'link');
    mkdirSync(target);
    symlinkSync(target, link, 'junction');
    expect(linkOnPath(join(link, 'profile'))).toBe(true);
    expect(linkOnPath(target)).toBe(false);
    expect(linkOnPath(join(target, 'missing', 'deeper'))).toBe(false);
  });

  it('finds a file that is also another name, since a copy would carry it into the run', () => {
    const tree = join(folder, 'hard-tree');
    mkdirSync(tree);
    writeFileSync(join(tree, 'a.bin'), '');
    expect(linkInside(tree)).toBeUndefined();
    linkSync(join(tree, 'a.bin'), join(tree, 'b.bin'));
    expect([join(tree, 'a.bin'), join(tree, 'b.bin')]).toContain(linkInside(tree));
  });

  it('finds a link anywhere inside a folder tree, and calls a clean tree clean', () => {
    const tree = join(folder, 'tree');
    const elsewhere = join(folder, 'elsewhere');
    mkdirSync(join(tree, 'deep'), { recursive: true });
    mkdirSync(elsewhere);
    writeFileSync(join(tree, 'deep', 'file.bin'), '');
    expect(linkInside(tree)).toBeUndefined();
    symlinkSync(elsewhere, join(tree, 'deep', 'jump'), 'junction');
    expect(linkInside(tree)).toBe(join(tree, 'deep', 'jump'));
  });

  it('finds a junction whose target is gone, since it is a link even though it is not a folder', () => {
    const target = join(folder, 'target');
    const link = join(folder, 'dangling');
    mkdirSync(target);
    symlinkSync(target, link, 'junction');
    rmSync(target, { recursive: true, force: true });
    expect(linkInside(link)).toBe(link);
    expect(linkInside(join(folder, 'no-such-folder'))).toBeUndefined();
  });

  it('reports a run folder that holds a junction or sits behind one, and calls a clean run folder clean', () => {
    expect(runFolderProblem(folder)).toBeUndefined();
    const target = join(folder, 'target');
    const link = join(folder, 'link');
    mkdirSync(target);
    symlinkSync(target, link, 'junction');
    expect(runFolderProblem(folder)).toContain(link);
    expect(runFolderProblem(join(link, 'profile'))).toContain('goes through a link or a junction');
  });
});

describe('the approved owner library count', () => {
  it('refuses nothing when no count is approved', () => {
    expect(ownerLibraryRefusal(undefined, 3221)).toBeNull();
  });

  it('accepts the approved count and refuses another one, naming both numbers', () => {
    expect(ownerLibraryRefusal(3221, 3221)).toBeNull();
    const refusal = ownerLibraryRefusal(3221, 3222);
    expect(refusal).toContain('3222');
    expect(refusal).toContain('3221');
    expect(ownerLibraryRefusal(Number('99999999999999999999'), 3221)).not.toBeNull();
  });

  it('reads the option as a whole number of files and refuses anything else', () => {
    expect(parseRunArgs(freshArgs(['--owner-library-files', '3221']), SCENARIOS)).toMatchObject({
      'owner-library-files': '3221',
    });
    for (const value of ['0', '007', 'many']) {
      expect(() => parseRunArgs(freshArgs(['--owner-library-files', value]), SCENARIOS)).toThrow(
        '--owner-library-files must be a whole number of files',
      );
    }
  });

  it('reads the approved count from the options, and none when no count is given', () => {
    expect(approvedOwnerFilesOf({})).toBeUndefined();
    expect(approvedOwnerFilesOf({ 'owner-library-files': '3221' })).toBe(3221);
  });
});

describe('the tool lookup', () => {
  it('finds a tool only in an absolute folder on PATH, never in a relative folder or the working folder', () => {
    expect(existsSync(join(process.cwd(), 'package.json'))).toBe(true);
    const tools = mkdtempSync(join(tmpdir(), 'tool-path-'));
    try {
      writeFileSync(join(tools, 'tool.exe'), '');
      expect(findOnPath('tool.exe', tools)).toBe(join(tools, 'tool.exe'));
      expect(findOnPath('tool.exe', relative(process.cwd(), tools))).toBeUndefined();
      expect(findOnPath('package.json', process.cwd())).toBeUndefined();
      expect(findOnPath('missing.exe', tools)).toBeUndefined();
    } finally {
      rmSync(tools, { recursive: true, force: true });
    }
  });
});

describe('the owner library folder count', () => {
  it('counts every file under the folder, including the files in its subfolders', () => {
    const folder = mkdtempSync(join(tmpdir(), 'owner-count-'));
    try {
      mkdirSync(join(folder, 'video', 'deep'), { recursive: true });
      writeFileSync(join(folder, 'catalog.json'), '{}');
      writeFileSync(join(folder, 'video', 'a.bin'), '1');
      writeFileSync(join(folder, 'video', 'deep', 'b.bin'), '2');
      expect(countFiles(folder)).toBe(3);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('the owner library count and signature through links', () => {
  let folder: string;
  let elsewhere: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'signature-'));
    elsewhere = mkdtempSync(join(tmpdir(), 'signature-target-'));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('does not count the files behind a junction', () => {
    writeFileSync(join(folder, 'a.bin'), '1');
    writeFileSync(join(elsewhere, 'x.bin'), '1');
    writeFileSync(join(elsewhere, 'y.bin'), '1');
    symlinkSync(elsewhere, join(folder, 'jump'), 'junction');
    expect(countFiles(folder)).toBe(1);
  });

  it('records a junction without following it, so a change inside its target leaves the signature as it was', () => {
    writeFileSync(join(folder, 'a.bin'), '1');
    const plain = folderSignature(folder);
    writeFileSync(join(elsewhere, 'x.bin'), '1');
    symlinkSync(elsewhere, join(folder, 'jump'), 'junction');
    const linked = folderSignature(folder);
    expect(linked).not.toBe(plain);
    writeFileSync(join(elsewhere, 'x.bin'), '12345');
    expect(folderSignature(folder)).toBe(linked);
  });

  it('is the same for an unchanged tree, and changes when an entry is added, renamed, resized or gains a second name', () => {
    expect(folderSignature(join(folder, 'missing'))).toBe('missing');
    mkdirSync(join(folder, 'video'));
    writeFileSync(join(folder, 'video', 'a.bin'), '12');
    const first = folderSignature(folder);
    expect(folderSignature(folder)).toBe(first);
    renameSync(join(folder, 'video', 'a.bin'), join(folder, 'video', 'b.bin'));
    const renamed = folderSignature(folder);
    expect(renamed).not.toBe(first);
    writeFileSync(join(folder, 'video', 'b.bin'), '123');
    const resized = folderSignature(folder);
    expect(resized).not.toBe(renamed);
    linkSync(join(folder, 'video', 'b.bin'), join(folder, 'video', 'c.bin'));
    const twoNames = folderSignature(folder);
    expect(twoNames).not.toBe(resized);
  });

  it('changes when an empty folder is added', () => {
    writeFileSync(join(folder, 'a.bin'), '1');
    const before = folderSignature(folder);
    mkdirSync(join(folder, 'empty'));
    expect(folderSignature(folder)).not.toBe(before);
  });

  it('changes when a file gains a second name outside the folder, which only its link count shows', () => {
    writeFileSync(join(folder, 'a.bin'), '1');
    const before = folderSignature(folder);
    linkSync(join(folder, 'a.bin'), join(elsewhere, 'outside.bin'));
    expect(folderSignature(folder)).not.toBe(before);
  });

  it('changes when the folder itself is swapped for a junction to another folder with the same files', () => {
    const base = mkdtempSync(join(tmpdir(), 'signature-root-'));
    try {
      const lib = join(base, 'lib');
      const clone = join(base, 'clone');
      mkdirSync(lib);
      mkdirSync(clone);
      writeFileSync(join(lib, 'a.bin'), '1');
      writeFileSync(join(clone, 'a.bin'), '1');
      const before = folderSignature(lib);
      renameSync(lib, join(base, 'moved'));
      symlinkSync(clone, lib, 'junction');
      expect(folderSignature(lib)).not.toBe(before);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('reports a same-size rewrite as a change once its modified time moves', () => {
    writeFileSync(join(folder, 'a.bin'), 'ab');
    const before = folderSignature(folder);
    writeFileSync(join(folder, 'a.bin'), 'cd');
    utimesSync(join(folder, 'a.bin'), new Date('2001-01-01'), new Date('2001-01-01'));
    const outcome = reportWithFolderChanges(
      { verdict: 'passed', blockers: [] as string[], receipt: { schema: 'receipt' } },
      [{ label: 'the owner library', before, after: folderSignature(folder) }],
    );
    expect(outcome.verdict).toBe('failed');
    expect(outcome.blockers).toEqual(['the owner library changed during the run']);
    expect(outcome.receipt).toBeUndefined();
  });
});

describe('the report after the folders are compared again', () => {
  const report = {
    verdict: 'passed',
    blockers: [] as string[],
    checks: [{ name: 'project-saved', status: 'passed' }],
    receipt: { schema: 'receipt' },
  };

  it('returns the report as it was when no folder changed', () => {
    expect(reportWithChanges(report, [])).toBe(report);
    expect(
      reportWithFolderChanges(report, [{ label: 'the owner library', before: 'x', after: 'x' }]),
    ).toBe(report);
  });

  it('fails the report and drops its receipt when a folder changed, and keeps its checks and blockers', () => {
    const outcome = reportWithChanges(report, ['the Downloads folder changed during the run']);
    expect(outcome).toEqual({
      verdict: 'failed',
      blockers: ['the Downloads folder changed during the run'],
      checks: [{ name: 'project-saved', status: 'passed' }],
      receipt: undefined,
    });
    expect(report.verdict).toBe('passed');
    expect(report.blockers).toEqual([]);
    expect(report.receipt).toEqual({ schema: 'receipt' });
  });

  it('appends the changes after the blockers the run already had', () => {
    const withBlocker = {
      ...report,
      verdict: 'failed',
      blockers: ['process 4000 did not close: x'],
    };
    const outcome = reportWithChanges(withBlocker, ['the owner library changed during the run']);
    expect(outcome.blockers).toEqual([
      'process 4000 did not close: x',
      'the owner library changed during the run',
    ]);
  });
});
