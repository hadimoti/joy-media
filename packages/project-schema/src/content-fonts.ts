/** Code-owned content font names shared by editor, preview, and export. */
export const CONTENT_FONT_FAMILIES = [
  'system-ui',
  'YekanBakh',
  'Vazin',
  'Tajrid',
  'Pulad',
  'Damoon Pro',
  'Bon',
  'Bonyade Koodak',
  'Shoor Pro',
  'Aviny',
  'Katibeh',
  'Tahrir',
  '898 Stencil',
  'Radio',
  'Falsafeh',
  'Paradox',
  'Gramophone',
  'Emkan Inline',
] as const;

export type ContentFontFamily = (typeof CONTENT_FONT_FAMILIES)[number];

export const CANONICAL_CONTENT_FONT_ALIASES = {
  'Yekan Bakh': 'YekanBakh',
  Vazirmatn: 'Vazin',
} as const;

export function canonicalizeContentFontFamily(value: string): string {
  const trimmed = value.trim();
  return (
    CANONICAL_CONTENT_FONT_ALIASES[trimmed as keyof typeof CANONICAL_CONTENT_FONT_ALIASES] ??
    trimmed
  );
}

export function isContentFontFamily(value: unknown): value is ContentFontFamily {
  return typeof value === 'string' && (CONTENT_FONT_FAMILIES as readonly string[]).includes(value);
}
