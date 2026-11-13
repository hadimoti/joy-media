/**
 * Humanize opaque media / clip ids for editor chrome.
 *
 * Examples:
 * - `intro` → `Intro`
 * - `b-roll-a` → `B-roll(A)`
 * - `flux-dev` → `Flux-dev`
 * - `Generated intro` → `Generated Intro`
 * - `JOY` → `JOY`
 */

const MEDIA_FILE_EXTENSION =
  /\.(mp4|m4v|mov|mkv|webm|avi|mxf|png|jpe?g|webp|gif|tiff?|heic|svg|wav|mp3|m4a|aac|flac|ogg|opus)$/i;

/**
 * Clip name for editor chrome: a media file name with its extension removed
 * (`product-shot.mp4` → `product-shot`). Anything without a known media
 * extension is returned trimmed and unchanged, so `Mr.Bean` and `v1.2 intro`
 * survive.
 */
export function clipNameWithoutExtension(raw: string): string {
  const trimmed = raw.trim();
  const stripped = trimmed.replace(MEDIA_FILE_EXTENSION, '').trim();
  return stripped.length > 0 ? stripped : trimmed;
}

/**
 * Clip name for chrome and history entries, from the clip's media name. A clip
 * with no media name gets `fallback`, never its id.
 */
export function clipNameFromMedia(mediaName: string | undefined, fallback: string): string {
  return clipNameWithoutExtension(mediaName ?? '') || fallback;
}

export function polishMediaLabel(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return trimmed;
  if (/^[A-Z0-9]{2,}$/.test(trimmed)) return trimmed;

  if (/\s/.test(trimmed)) {
    return trimmed
      .split(/\s+/)
      .map((word) => {
        if (/^[A-Z0-9]{2,}$/.test(word)) return word;
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join(' ');
  }

  const parts = trimmed.split(/[-_]+/).filter(Boolean);
  if (parts.length === 0) return trimmed;

  const last = parts[parts.length - 1]!;
  if (parts.length >= 2 && /^[a-z]$/i.test(last)) {
    const head = parts
      .slice(0, -1)
      .map((part, index) =>
        index === 0
          ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
          : part.toLowerCase(),
      )
      .join('-');
    return `${head}(${last.toUpperCase()})`;
  }

  if (parts.length === 1) {
    const only = parts[0]!;
    return only.charAt(0).toUpperCase() + only.slice(1).toLowerCase();
  }

  return parts
    .map((part, index) =>
      index === 0 ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part.toLowerCase(),
    )
    .join('-');
}
