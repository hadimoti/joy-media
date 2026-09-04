import { CONTENT_FONT_CATALOG, type ContentFontFamily } from '@joy-media/project-schema';

/** Metadata for a font that can be shown in the picker/catalog. */
export interface FontCatalogEntry {
  readonly family: string;
  readonly label: string;
  readonly scripts: string;
  readonly weights: string;
  readonly license: string;
  readonly source: string;
  /** True only for faces that are bundled and safe to apply immediately. */
  readonly bundled: boolean;
}

export type LocalFontCatalogEntry = FontCatalogEntry & {
  readonly family: ContentFontFamily;
};

export interface FontCatalogFetchResponse {
  readonly items?: readonly GoogleFontItem[];
}

interface GoogleFontItem {
  readonly family?: string;
  readonly subsets?: readonly string[];
  readonly variants?: readonly string[];
}

export interface FontCatalogSession {
  readonly localEntries: readonly LocalFontCatalogEntry[];
  readonly hasGoogleApiKey: () => boolean;
  readonly setGoogleApiKey: (value: string) => void;
  readonly clearGoogleApiKey: () => void;
  readonly discoverGoogleFonts: (fetchImpl?: typeof fetch) => Promise<readonly FontCatalogEntry[]>;
}

export const GOOGLE_WEBFONTS_ENDPOINT = 'https://www.googleapis.com/webfonts/v1/webfonts';
export const GOOGLE_FONT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_GOOGLE_CATALOG_ITEMS = 500;

const localEntries: readonly LocalFontCatalogEntry[] = CONTENT_FONT_CATALOG.map((font) => ({
  ...font,
  bundled: font.bundled,
}));

function normalizeApiKey(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function mapGoogleFont(item: GoogleFontItem): FontCatalogEntry | undefined {
  const family = item.family?.trim();
  if (family === undefined || family.length === 0) return undefined;
  const variants = (item.variants ?? []).filter((variant) => /^\d{3}$/.test(variant));
  return {
    family,
    label: family,
    scripts: (item.subsets ?? []).join(' · ') || 'Google Fonts catalog',
    weights: variants.length > 0 ? variants.join(', ') : 'Provider-defined',
    license: 'Metadata only — verify the family license before bundling',
    source: 'Google Fonts Developer API (optional, metadata only)',
    bundled: false,
  };
}

function sanitizeCatalogError(error: unknown, apiKey: string | undefined): Error {
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : 'Google Fonts catalog request failed';
  const redacted = apiKey === undefined ? message : message.split(apiKey).join('[redacted]');
  return new Error(redacted);
}

/**
 * Create a browser-memory-only catalog session. The key is held in a closure,
 * never persisted, returned, logged, or sent to the JOY backend. The optional
 * Google endpoint is metadata-only; applying fonts still requires adding a
 * reviewed, pinned local package to the catalog.
 */
export function createFontCatalogSession(): FontCatalogSession {
  let googleApiKey: string | undefined;
  return {
    localEntries,
    hasGoogleApiKey: () => googleApiKey !== undefined,
    setGoogleApiKey: (value) => {
      googleApiKey = normalizeApiKey(value);
    },
    clearGoogleApiKey: () => {
      googleApiKey = undefined;
    },
    discoverGoogleFonts: async (fetchImpl = fetch) => {
      const key = googleApiKey;
      if (key === undefined) return localEntries;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GOOGLE_FONT_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetchImpl(
          `${GOOGLE_WEBFONTS_ENDPOINT}?sort=popularity&key=${encodeURIComponent(key)}`,
          { headers: { Accept: 'application/json' }, signal: controller.signal },
        );
        if (!response.ok)
          throw new Error(`Google Fonts catalog request failed (${response.status})`);
        const payload = (await response.json()) as FontCatalogFetchResponse;
        const remote = (payload.items ?? [])
          .slice(0, MAX_GOOGLE_CATALOG_ITEMS)
          .map(mapGoogleFont)
          .filter((entry): entry is FontCatalogEntry => entry !== undefined);
        return [...localEntries, ...remote];
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('Google Fonts catalog request timed out');
        }
        throw sanitizeCatalogError(error, key);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

let pageFontCatalogSession: FontCatalogSession | undefined;

/**
 * Return the page-scoped in-memory catalog session used by editor surfaces.
 * This intentionally survives React panel unmounts but is lost on a full
 * reload; there is no localStorage, IndexedDB, cookie, or backend fallback.
 */
export function getPageFontCatalogSession(): FontCatalogSession {
  pageFontCatalogSession ??= createFontCatalogSession();
  return pageFontCatalogSession;
}
