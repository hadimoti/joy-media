import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';

type VersionInfoOptions = {
  version: string;
  productName: string;
  fileDescription: string;
  companyName: string;
  internalName: string;
  originalFilename: string;
};
// The build script is plain .mjs; it is loaded by URL so the type checker does not pull it into this project.
const scriptUrl = pathToFileURL(
  join(import.meta.dirname, '..', 'scripts', 'set-exe-icon.mjs'),
).href;
const { setExecutableVersionInfo } = (await import(scriptUrl)) as {
  setExecutableVersionInfo: (exePath: string, options: VersionInfoOptions) => Promise<void>;
};

const require = createRequire(import.meta.url);
// The electron package's main export is the path of the prebuilt electron.exe, which carries a version resource.
const electronExe = require('electron') as unknown as string;
const isWindowsBinary = process.platform === 'win32';

let scratch: string | undefined;
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

type StringValues = Record<string, string>;
type VersionInfo = {
  fixedInfo: { productVersionMS: number; productVersionLS: number };
  getAllLanguagesForStringValues(): Array<{ lang: number; codepage: number }>;
  getStringValues(language: { lang: number; codepage: number }): StringValues;
};
type Resedit = {
  NtExecutable: { from(bin: Buffer): unknown };
  NtExecutableResource: { from(exe: unknown): { entries: unknown[] } };
  Resource: { VersionInfo: { fromEntries(entries: unknown[]): VersionInfo[] } };
};
// resedit's typings pull in the DOM lib (through pe-library), which would change the global fetch types for the
// whole desktop project, so it is loaded without its declarations.
const reseditModule = 'resedit';
const { NtExecutable, NtExecutableResource, Resource } = (await import(reseditModule)) as Resedit;

async function readVersionInfo(exePath: string) {
  const exe = NtExecutable.from(await readFile(exePath));
  const res = NtExecutableResource.from(exe);
  const [info] = Resource.VersionInfo.fromEntries(res.entries);
  if (!info) throw new Error('No version resource in ' + exePath);
  const strings = info.getAllLanguagesForStringValues().map((lang) => info.getStringValues(lang));
  return { info, strings };
}

describe.runIf(isWindowsBinary)('setExecutableVersionInfo', () => {
  it('writes ProductVersion exactly as major.minor.patch and FileVersion with a fourth part', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'joy-exe-version-'));
    const exePath = join(scratch, 'joy-media.exe');
    await copyFile(electronExe, exePath);

    await setExecutableVersionInfo(exePath, {
      version: '1.1.1',
      productName: 'JOY Media',
      fileDescription: 'JOY Media',
      companyName: 'JOY Team',
      internalName: 'joy-media',
      originalFilename: 'joy-media.exe',
    });

    const { info, strings } = await readVersionInfo(exePath);
    expect(strings.length).toBeGreaterThan(0);
    for (const values of strings) {
      expect(values.ProductVersion).toBe('1.1.1');
      expect(values.FileVersion).toBe('1.1.1.0');
      expect(values.ProductName).toBe('JOY Media');
    }
    expect(info.fixedInfo.productVersionMS).toBe((1 << 16) | 1);
    expect(info.fixedInfo.productVersionLS).toBe(1 << 16);
  }, 60_000);
});
