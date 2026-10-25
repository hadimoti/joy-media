import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stageNotoSansArabicFonts } from './copy-cli-fonts.mjs';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const WOFF2 = [
  ['noto-sans-arabic-arabic-400-normal.woff2', 400, 'arabic'],
  ['noto-sans-arabic-arabic-700-normal.woff2', 700, 'arabic'],
  ['noto-sans-arabic-latin-400-normal.woff2', 400, 'latin'],
  ['noto-sans-arabic-latin-700-normal.woff2', 700, 'latin'],
];
const TTF = [
  ['noto-sans-arabic-arabic-400-normal.ttf', 400, 'arabic'],
  ['noto-sans-arabic-arabic-700-normal.ttf', 700, 'arabic'],
  ['noto-sans-arabic-latin-400-normal.ttf', 400, 'latin'],
  ['noto-sans-arabic-latin-700-normal.ttf', 700, 'latin'],
];
const EXPECTED = [
  'LICENSE-OFL.txt',
  ...TTF.map(([file]) => `libass/fonts/${file}`),
  'libass/manifest.json',
  'manifest.json',
  ...WOFF2.map(([file]) => file),
].sort();

function pinned(file, bytes, extra = {}) {
  return {
    family: 'Noto Sans Arabic',
    file,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    ...extra,
  };
}

/** Writes a font folder in the layout that apps/cli/dist/fonts/noto-sans-arabic uses. */
function writeFontFolder(root, options = {}) {
  const { license = 'OFL-1.1', tamperTtf, dropTtf, extraFile } = options;
  const woff2 = new Map(
    WOFF2.map(([file, weight, subset]) => [file, Buffer.from(`${subset}-${weight}-woff2`)]),
  );
  const ttf = new Map(
    TTF.map(([file, weight]) => [file, Buffer.from([0, 1, 0, 0, weight & 0xff])]),
  );
  mkdirSync(join(root, 'libass', 'fonts'), { recursive: true });
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({
      license,
      files: WOFF2.map(([file, weight, subset]) =>
        pinned(file, woff2.get(file), { weight, subset }),
      ),
    }),
  );
  writeFileSync(join(root, 'LICENSE-OFL.txt'), 'SIL Open Font License 1.1\n');
  for (const [file, bytes] of woff2) writeFileSync(join(root, file), bytes);
  writeFileSync(
    join(root, 'libass', 'manifest.json'),
    JSON.stringify({
      license: 'OFL-1.1',
      files: TTF.map(([file, weight, subset]) => pinned(file, ttf.get(file), { weight, subset })),
    }),
  );
  for (const [file, weight] of TTF) {
    if (file === dropTtf) continue;
    // A tampered copy keeps its length, so only the SHA-256 check can reject it.
    const altered = Buffer.from([0, 1, 0, 0, (weight & 0xff) ^ 1]);
    writeFileSync(
      join(root, 'libass', 'fonts', file),
      file === tamperTtf ? altered : ttf.get(file),
    );
  }
  if (extraFile !== undefined) writeFileSync(join(root, 'libass', 'fonts', extraFile), 'extra');
  return root;
}

describe('stageNotoSansArabicFonts', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'joy-cli-fonts-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('stages every font file the CLI bundle lists, byte for byte', () => {
    const source = writeFontFolder(join(root, 'source'));
    const destination = join(root, 'app', 'cli', 'fonts', 'noto-sans-arabic');
    const staged = stageNotoSansArabicFonts({
      sourceDirectory: source,
      destinationDirectory: destination,
    });
    expect(staged).toEqual(EXPECTED);
    for (const file of staged) {
      expect(readFileSync(join(destination, file))).toEqual(readFileSync(join(source, file)));
    }
  });

  it('refuses a font that no longer matches its pinned digest, and stages nothing', () => {
    const source = writeFontFolder(join(root, 'source'), {
      tamperTtf: 'noto-sans-arabic-arabic-400-normal.ttf',
    });
    const destination = join(root, 'destination');
    expect(() =>
      stageNotoSansArabicFonts({ sourceDirectory: source, destinationDirectory: destination }),
    ).toThrow(/does not match its pinned length and digest/);
    expect(existsSync(destination)).toBe(false);
  });

  it('refuses a folder that is missing a pinned font', () => {
    const source = writeFontFolder(join(root, 'source'), {
      dropTtf: 'noto-sans-arabic-arabic-700-normal.ttf',
    });
    const destination = join(root, 'destination');
    expect(() =>
      stageNotoSansArabicFonts({ sourceDirectory: source, destinationDirectory: destination }),
    ).toThrow(/missing/);
    expect(existsSync(destination)).toBe(false);
  });

  it('refuses a folder with a file that no manifest pins', () => {
    const source = writeFontFolder(join(root, 'source'), { extraFile: 'stray.ttf' });
    const destination = join(root, 'destination');
    expect(() =>
      stageNotoSansArabicFonts({ sourceDirectory: source, destinationDirectory: destination }),
    ).toThrow(/unexpected files/);
    expect(existsSync(destination)).toBe(false);
  });

  it('refuses a font folder whose manifest is not OFL-1.1', () => {
    const source = writeFontFolder(join(root, 'source'), { license: 'GPL-3.0' });
    expect(() =>
      stageNotoSansArabicFonts({
        sourceDirectory: source,
        destinationDirectory: join(root, 'destination'),
      }),
    ).toThrow(/OFL-1\.1/);
  });

  it('replaces files left by an earlier staging', () => {
    const source = writeFontFolder(join(root, 'source'));
    const destination = join(root, 'destination');
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'stale.woff2'), 'left over');
    stageNotoSansArabicFonts({ sourceDirectory: source, destinationDirectory: destination });
    expect(existsSync(join(destination, 'stale.woff2'))).toBe(false);
  });

  const bundledFonts = fileURLToPath(
    new URL('../../../apps/cli/dist/fonts/noto-sans-arabic', import.meta.url),
  );
  it.skipIf(!existsSync(join(bundledFonts, 'manifest.json')))(
    'stages the folder that the CLI bundle produces',
    () => {
      const staged = stageNotoSansArabicFonts({
        sourceDirectory: bundledFonts,
        destinationDirectory: join(root, 'destination'),
      });
      expect(staged).toEqual(EXPECTED);
    },
  );
});
