// Local-only: the packaged renderer and the dev server are the only editor origins.
// No remote origin is trusted (PLAN-v4 §4a; ADR-0043).
export const ALLOWED_EDITOR_ORIGINS = [
  'joy-media-app://renderer',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;
export function isAllowedEditorOrigin(origin: string): boolean {
  return (ALLOWED_EDITOR_ORIGINS as readonly string[]).includes(origin);
}
export function assertAllowedEditorOrigin(origin: string): void {
  if (!isAllowedEditorOrigin(origin)) throw new Error(`Blocked editor origin: ${origin}`);
}

/**
 * The origin a page URL is checked against. A custom scheme such as `joy-media-app:` has no WHATWG
 * origin (its `URL.origin` is "null"), so the scheme and host are read instead. Undefined when the
 * URL does not parse.
 */
export function originOfPageUrl(pageUrl: string): string | undefined {
  try {
    const url = new URL(pageUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}
