import { CAPTION_FONT_FAMILY } from '@joy-media/captions-core';
import { p0TitleFontFaces } from './p0-title-fonts.js';

/**
 * Registers the bundled caption face under CAPTION_FONT_FAMILY, and nothing else. The bytes come from
 * p0TitleFontFaces, which checks them against the bundled manifest's SHA-256 before they are returned,
 * so a damaged or swapped file stops here instead of drawing a different face.
 *
 * Only the Arabic-subset Noto Sans Arabic 400 face is registered. Persian captions are Arabic-script text,
 * and the unicode range keeps any Latin text on the editor's own faces.
 */
const ARABIC_UNICODE_RANGE = 'U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF';

let registration: Promise<void> | undefined;

/**
 * Loads the verified caption face into this page once. Preview may start before it resolves; export waits
 * for it and fails when it cannot be registered, so a caption is never exported in a fallback face.
 */
export function registerCaptionFont(): Promise<void> {
  registration ??= registerVerifiedFace();
  return registration;
}

async function registerVerifiedFace(): Promise<void> {
  const face = (await p0TitleFontFaces()).find(
    (entry) => entry.weight === 400 && entry.subset === 'arabic',
  );
  if (face === undefined)
    throw new Error('The bundled caption face is missing from the verified font set.');
  const bytes = Uint8Array.from(atob(face.bytesBase64), (character) => character.charCodeAt(0));
  const fontFace = new FontFace(CAPTION_FONT_FAMILY, bytes, {
    style: 'normal',
    weight: '400',
    unicodeRange: ARABIC_UNICODE_RANGE,
  });
  document.fonts.add(await fontFace.load());
}
