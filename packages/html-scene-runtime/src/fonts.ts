import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NotoSansArabicFace {
  readonly family: 'Noto Sans Arabic';
  readonly weight: 400 | 700;
  readonly subset: 'arabic' | 'latin';
  readonly sha256: `sha256:${string}`;
  readonly bytes: Uint8Array;
}

interface FontManifest {
  readonly source: string;
  readonly license: string;
  readonly files: readonly {
    readonly family: string;
    readonly weight: number;
    readonly subset: string;
    readonly file: string;
    readonly byteLength: number;
    readonly sha256: string;
  }[];
}

/**
 * Search order: first fonts/noto-sans-arabic beside a packaged CLI bundle;
 * then ../assets/fonts/noto-sans-arabic beside this package's src or dist
 * module. The package-local path is shared by source and built distributions.
 */
function fontDirectories(): string[] {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return [
    join(moduleDirectory, 'fonts', 'noto-sans-arabic'),
    join(moduleDirectory, '../assets/fonts/noto-sans-arabic'),
  ];
}
const EXPECTED_FONT_FILES = [
  'noto-sans-arabic-arabic-400-normal.woff2',
  'noto-sans-arabic-arabic-700-normal.woff2',
  'noto-sans-arabic-latin-400-normal.woff2',
  'noto-sans-arabic-latin-700-normal.woff2',
];

/** Reads the bundled canonical font files and rejects any manifest drift. */
export function loadNotoSansArabicFaces(): NotoSansArabicFace[] {
  const fontDirectory = fontDirectories().find((directory) =>
    existsSync(join(directory, 'manifest.json')),
  );
  if (!fontDirectory) {
    throw new Error(
      `Noto Sans Arabic fonts are missing. Searched: ${fontDirectories().join(', ')}`,
    );
  }
  const manifest = JSON.parse(
    readFileSync(join(fontDirectory, 'manifest.json'), 'utf8'),
  ) as FontManifest;
  if (manifest.source !== '@fontsource/noto-sans-arabic@5.2.6' || manifest.license !== 'OFL-1.1') {
    throw new Error('Noto Sans Arabic font manifest source or license is invalid');
  }
  if (
    manifest.files.length !== EXPECTED_FONT_FILES.length ||
    EXPECTED_FONT_FILES.some((file) => !manifest.files.some((entry) => entry.file === file))
  ) {
    throw new Error(
      'Noto Sans Arabic font manifest must list the four bundled weight/subset files',
    );
  }
  return manifest.files.map((entry) => {
    if (
      entry.family !== 'Noto Sans Arabic' ||
      (entry.weight !== 400 && entry.weight !== 700) ||
      (entry.subset !== 'arabic' && entry.subset !== 'latin') ||
      !/^noto-sans-arabic-(arabic|latin)-(400|700)-normal\.woff2$/.test(entry.file)
    ) {
      throw new Error(`Noto Sans Arabic font manifest entry is invalid: ${entry.file}`);
    }
    const fontPath = join(fontDirectory, entry.file);
    if (!existsSync(fontPath)) {
      throw new Error(`Noto Sans Arabic font file is missing: ${fontPath}`);
    }
    const bytes = new Uint8Array(readFileSync(fontPath));
    const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (bytes.byteLength !== entry.byteLength || sha256 !== entry.sha256) {
      throw new Error(`Noto Sans Arabic font integrity check failed: ${entry.file}`);
    }
    return {
      family: 'Noto Sans Arabic',
      weight: entry.weight,
      subset: entry.subset,
      sha256: sha256 as `sha256:${string}`,
      bytes,
    };
  });
}

/** Returns the integrity-checked bundled Arabic 400 WOFF2 path for external renderers. */
/**
 * A TrueType face for FFmpeg's libass. libass cannot open the WOFF2 faces above, and a Windows
 * build cannot read them either, so captions draw from these files.
 */
export interface NotoSansArabicLibassFace {
  readonly family: string;
  readonly weight: number;
  readonly subset: string;
  readonly file: string;
  readonly sha256: `sha256:${string}`;
  readonly bytes: Buffer;
}

interface LibassFontManifest {
  readonly license: string;
  readonly files: readonly {
    readonly family: string;
    readonly weight: number;
    readonly subset: string;
    readonly file: string;
    readonly byteLength: number;
    readonly sha256: `sha256:${string}`;
  }[];
}

const LIBASS_FONT_FILES = [
  'noto-sans-arabic-arabic-400-normal.ttf',
  'noto-sans-arabic-arabic-700-normal.ttf',
  'noto-sans-arabic-latin-400-normal.ttf',
  'noto-sans-arabic-latin-700-normal.ttf',
] as const;

/** The folder libass scans: it holds the TrueType files and nothing else. */
function libassFontDirectory(): string {
  const directory = fontDirectories().find((candidate) =>
    existsSync(join(candidate, 'libass', 'manifest.json')),
  );
  if (!directory) throw new Error('Noto Sans Arabic libass font directory is missing');
  return join(directory, 'libass', 'fonts');
}

/** Verified TrueType faces for libass. Each file must match its pinned length and digest. */
export function loadNotoSansArabicLibassFaces(): NotoSansArabicLibassFace[] {
  const fontDirectory = libassFontDirectory();
  const manifest = JSON.parse(
    readFileSync(join(fontDirectory, '..', 'manifest.json'), 'utf8'),
  ) as LibassFontManifest;
  if (manifest.license !== 'OFL-1.1') {
    throw new Error('Noto Sans Arabic libass font license is invalid');
  }
  if (
    manifest.files.length !== LIBASS_FONT_FILES.length ||
    LIBASS_FONT_FILES.some((file) => !manifest.files.some((entry) => entry.file === file))
  ) {
    throw new Error('Noto Sans Arabic libass manifest must list the four bundled TrueType files');
  }
  return manifest.files.map((entry) => {
    const bytes = readFileSync(join(fontDirectory, entry.file));
    const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (bytes.byteLength !== entry.byteLength || sha256 !== entry.sha256) {
      throw new Error(`${entry.file} does not match its pinned length and digest`);
    }
    if (bytes.subarray(0, 4).toString('hex') !== '00010000') {
      throw new Error(`${entry.file} is not a TrueType font`);
    }
    return {
      family: entry.family,
      weight: entry.weight,
      subset: entry.subset,
      file: entry.file,
      sha256,
      bytes,
    };
  });
}

/** The TrueType file the caption renderer hands to libass. */
export function notoSansArabicArabic400Path(): string {
  const face = loadNotoSansArabicLibassFaces().find(
    (item) => item.subset === 'arabic' && item.weight === 400,
  );
  if (!face) throw new Error('Canonical Noto Sans Arabic Arabic 400 libass face is missing');
  return join(libassFontDirectory(), face.file);
}

/** Makes byte-identical data URLs for isolated document @font-face rules. */
export function notoSansArabicFontCss(faces = loadNotoSansArabicFaces()): string {
  return faces
    .map((face) => {
      const unicodeRange =
        face.subset === 'arabic'
          ? 'U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF'
          : 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
      const bytesBase64 = Buffer.from(face.bytes).toString('base64');
      return `@font-face{font-family:'${face.family}';font-style:normal;font-weight:${face.weight};font-display:block;unicode-range:${unicodeRange};src:url(data:font/woff2;base64,${bytesBase64}) format('woff2');}`;
    })
    .join('');
}

/** Browser-safe descriptor payload for createSandboxedIframeDescriptor(). */
export function loadNotoSansArabicPreviewFontFaces(): {
  family: string;
  weight: 400 | 700;
  subset: 'arabic' | 'latin';
  bytesBase64: string;
}[] {
  return loadNotoSansArabicFaces().map((face) => ({
    family: face.family,
    weight: face.weight,
    subset: face.subset,
    bytesBase64: Buffer.from(face.bytes).toString('base64'),
  }));
}
