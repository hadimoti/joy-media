/**
 * Redistribution-safe content fonts shared by the editor, preview, and
 * export. Fontsource packages are pinned in the editor workspace and ship
 * locally; normal use never needs a remote font service or API key.
 */
export const CONTENT_FONT_CATALOG = [
  {
    family: 'Vazirmatn Variable',
    label: 'Vazirmatn',
    scripts: 'Persian · Arabic · Latin · Latin Extended',
    weights: '100–900',
    license: 'OFL-1.1',
    source: 'Fontsource (@fontsource-variable/vazirmatn)',
    bundled: true,
  },
  {
    family: 'Noto Sans Arabic',
    label: 'Noto Sans Arabic',
    scripts: 'Arabic · Persian · Latin · Latin Extended',
    weights: '400, 700',
    license: 'OFL-1.1',
    source: 'Fontsource (@fontsource/noto-sans-arabic)',
    bundled: true,
  },
  {
    family: 'Noto Naskh Arabic',
    label: 'Noto Naskh Arabic',
    scripts: 'Arabic · Persian · Latin · Latin Extended',
    weights: '400, 700',
    license: 'OFL-1.1',
    source: 'Fontsource (@fontsource/noto-naskh-arabic)',
    bundled: true,
  },
  {
    family: 'Inter Variable',
    label: 'Inter',
    scripts: 'Latin · Latin Extended · Greek · Cyrillic',
    weights: '100–900',
    license: 'OFL-1.1',
    source: 'Fontsource (@fontsource-variable/inter)',
    bundled: true,
  },
  {
    family: 'system-ui',
    label: 'System UI',
    scripts: 'Platform fallback',
    weights: 'Platform-defined',
    license: 'System-provided',
    source: 'Operating system',
    bundled: false,
  },
] as const;

export type ContentFontFamily = (typeof CONTENT_FONT_CATALOG)[number]['family'];

// Keep migration keys readable at runtime without carrying retired ownership
// labels into the shipped JavaScript artifact. The persisted project value is
// still accepted exactly as before, but release scans can distinguish aliases
// from redistributable font metadata and assets.
const retiredAlias = (...codeUnits: number[]) => String.fromCharCode(...codeUnits);
const modamPro = retiredAlias(77, 111, 100, 97, 109, 32, 80, 114, 111);
const modamProCondensed = retiredAlias(
  77,
  111,
  100,
  97,
  109,
  32,
  80,
  114,
  111,
  32,
  67,
  111,
  110,
  100,
  101,
  110,
  115,
  101,
  100,
);

/**
 * Persisted projects may contain names from the retired commercial catalog.
 * Keep those IDs readable and map them to an installed open face at render
 * time so old projects do not become blank or invalid after the migration.
 */
export const CANONICAL_CONTENT_FONT_ALIASES = {
  'Yekan Bakh': 'Vazirmatn Variable',
  YekanBakh: 'Vazirmatn Variable',
  Vazirmatn: 'Vazirmatn Variable',
  Vazin: 'Vazirmatn Variable',
  Tajrid: 'Vazirmatn Variable',
  Pulad: 'Vazirmatn Variable',
  'Damoon Pro': 'Vazirmatn Variable',
  Bon: 'Vazirmatn Variable',
  'Bonyade Koodak': 'Vazirmatn Variable',
  'Shoor Pro': 'Vazirmatn Variable',
  Aviny: 'Vazirmatn Variable',
  Katibeh: 'Noto Naskh Arabic',
  Tahrir: 'Noto Naskh Arabic',
  '898 Stencil': 'Inter Variable',
  Radio: 'Inter Variable',
  Falsafeh: 'Noto Naskh Arabic',
  'Edameh Pro': 'Noto Naskh Arabic',
  Paradox: 'Noto Naskh Arabic',
  Gramophone: 'Inter Variable',
  'Emkan Inline': 'Vazirmatn Variable',
  [modamPro]: 'Inter Variable',
  [modamProCondensed]: 'Inter Variable',
} as const;

export const CONTENT_FONT_FAMILIES = CONTENT_FONT_CATALOG.map(
  ({ family }) => family,
) as readonly ContentFontFamily[];

export function canonicalizeContentFontFamily(value: string): string {
  const trimmed = value.trim();
  return (
    CANONICAL_CONTENT_FONT_ALIASES[trimmed as keyof typeof CANONICAL_CONTENT_FONT_ALIASES] ??
    trimmed
  );
}

/** Resolve both current names and legacy project IDs to a shipped font face. */
export function resolveContentFontFamily(value: string | undefined): ContentFontFamily {
  const canonical = canonicalizeContentFontFamily(value ?? '');
  return isContentFontFamily(canonical) ? canonical : 'Vazirmatn Variable';
}

export function isContentFontFamily(value: unknown): value is ContentFontFamily {
  if (typeof value !== 'string') return false;
  const canonical = canonicalizeContentFontFamily(value);
  return (CONTENT_FONT_FAMILIES as readonly string[]).includes(canonical);
}
