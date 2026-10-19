import type { ScenePreviewFontFace } from '@joy-media/html-scene-runtime/browser';
import fontManifest from '../../../packages/html-scene-runtime/assets/fonts/noto-sans-arabic/manifest.json' with { type: 'json' };

export interface P0TitleFontDescriptor {
  readonly family: 'Noto Sans Arabic';
  readonly weight: 400 | 700;
  readonly subset: 'arabic' | 'latin';
  readonly url: string;
  readonly sha256: string;
}

const base = '../../../packages/html-scene-runtime/assets/fonts/noto-sans-arabic/';
export const P0_TITLE_FONTS: readonly P0TitleFontDescriptor[] = [
  {
    family: 'Noto Sans Arabic',
    weight: 400,
    subset: 'arabic',
    url: `${base}noto-sans-arabic-arabic-400-normal.woff2`,
    sha256: 'sha256:9a7c99eccfc3845950358733520688959bfa77ea14e6ef3b0a5efe3a8d52d28b',
  },
  {
    family: 'Noto Sans Arabic',
    weight: 700,
    subset: 'arabic',
    url: `${base}noto-sans-arabic-arabic-700-normal.woff2`,
    sha256: 'sha256:b2b3ca0a17a734e33dd39b599faff30e6683f0df14cf3426a5015b22e1f28ca3',
  },
  {
    family: 'Noto Sans Arabic',
    weight: 400,
    subset: 'latin',
    url: `${base}noto-sans-arabic-latin-400-normal.woff2`,
    sha256: 'sha256:f9585bf238cf88ed66a321c4ae0179a756ee8820303279d80c84427672e9320a',
  },
  {
    family: 'Noto Sans Arabic',
    weight: 700,
    subset: 'latin',
    url: `${base}noto-sans-arabic-latin-700-normal.woff2`,
    sha256: 'sha256:6619b33801f18a3070793f6a3fff5203d48005eb0826d5feb97cce0dea17bbaa',
  },
];

export async function p0TitleFontFaces(): Promise<readonly ScenePreviewFontFace[]> {
  return Promise.all(
    P0_TITLE_FONTS.map(async (font) => {
      const url = new URL(font.url, import.meta.url);
      let bytes: Uint8Array;
      if (typeof window !== 'undefined') {
        const response = await fetch(url);
        if (!response.ok)
          throw new Error(`P0 title font unavailable: ${font.subset} ${font.weight}`);
        bytes = new Uint8Array(await response.arrayBuffer());
      } else {
        const [{ readFile }, { fileURLToPath }] = await Promise.all([
          import('node:fs/promises'),
          import('node:url'),
        ]);
        bytes = new Uint8Array(await readFile(fileURLToPath(url)));
      }
      const manifestEntry = fontManifest.files.find(
        (entry) =>
          entry.family === font.family &&
          entry.weight === font.weight &&
          entry.subset === font.subset,
      );
      if (manifestEntry === undefined)
        throw new Error(
          `P0 title font missing from bundled manifest: ${font.subset} ${font.weight}`,
        );
      if (bytes.byteLength !== manifestEntry.byteLength)
        throw new Error(`P0 title font byte length mismatch: ${font.subset} ${font.weight}`);
      const digestBytes = Uint8Array.from(bytes).buffer;
      const digest = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', digestBytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      if (digest !== font.sha256 || digest !== manifestEntry.sha256)
        throw new Error(`P0 title font integrity mismatch: ${font.subset} ${font.weight}`);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return {
        family: font.family,
        weight: font.weight,
        subset: font.subset,
        bytesBase64: btoa(binary),
      };
    }),
  );
}
