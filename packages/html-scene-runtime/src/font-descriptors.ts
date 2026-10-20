import manifest from '../assets/fonts/noto-sans-arabic/manifest.json' with { type: 'json' };
import type { FontFaceDescriptorV1 } from '@joy-media/project-schema';

interface BundledFontManifest {
  readonly source: string;
  readonly license: string;
  readonly files: readonly {
    readonly family: string;
    readonly weight: number;
    readonly subset: string;
    readonly byteLength: number;
    readonly sha256: string;
  }[];
}

const fontManifest = manifest as BundledFontManifest;

if (
  fontManifest.source !== '@fontsource/noto-sans-arabic@5.2.6' ||
  fontManifest.license !== 'OFL-1.1'
) {
  throw new Error('Noto Sans Arabic font manifest source or license is invalid');
}
if (fontManifest.files.length !== 4) {
  throw new Error('Noto Sans Arabic font manifest must list four canonical faces');
}

/** Canonical browser-safe paint descriptors, derived from the bundled manifest. */
export const SCENE_PAINT_FONT_DESCRIPTORS: readonly FontFaceDescriptorV1[] = Object.freeze(
  fontManifest.files.map((entry) => {
    if (
      entry.family !== 'Noto Sans Arabic' ||
      (entry.weight !== 400 && entry.weight !== 700) ||
      (entry.subset !== 'arabic' && entry.subset !== 'latin') ||
      !Number.isSafeInteger(entry.byteLength) ||
      entry.byteLength < 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error('Noto Sans Arabic font manifest entry is invalid');
    }
    return Object.freeze({
      family: entry.family,
      weight: entry.weight,
      subset: entry.subset,
      sha256: entry.sha256,
      length: entry.byteLength,
    });
  }),
);

export function scenePaintFontDescriptors(): readonly FontFaceDescriptorV1[] {
  return SCENE_PAINT_FONT_DESCRIPTORS;
}

export function isCanonicalScenePaintFont(value: unknown): value is FontFaceDescriptorV1 {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<FontFaceDescriptorV1>;
  return SCENE_PAINT_FONT_DESCRIPTORS.some(
    (face) =>
      candidate.family === face.family &&
      candidate.weight === face.weight &&
      candidate.subset === face.subset &&
      candidate.sha256 === face.sha256 &&
      candidate.length === face.length,
  );
}
