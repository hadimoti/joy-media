/**
 * Build-fingerprinted URLs for the panel/tab PNG glyphs.
 *
 * These used to sit in `public/assets/icons/` and be referenced by literal
 * path, so every icon had a fixed URL with `Cache-Control: max-age=14400` and
 * no content hash. Replacing an icon therefore changed nothing for anyone
 * holding the old file — browsers and the CDN kept serving the previous art
 * for hours, while the origin was already correct.
 *
 * Importing them through Vite instead means a changed icon is a changed URL,
 * so a redeploy can never show stale art. `import.meta.glob` keeps that
 * automatic: drop a PNG in `panel-icons/` and it is available here.
 */

const ICON_URLS: Readonly<Record<string, string>> = import.meta.glob('./panel-icons/**/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
});

/**
 * @param relative path under `src/panel-icons/`, e.g. `ui/motion_24x24.png`.
 * Throws rather than rendering an invisible glyph — a missing icon is a build
 * mistake, and a silent empty mask is very hard to spot in review.
 */
export function iconUrl(relative: string): string {
  const url = ICON_URLS[`./panel-icons/${relative}`];
  if (url === undefined) {
    throw new Error(`icon-assets: no such icon "${relative}" under src/panel-icons/`);
  }
  return url;
}
