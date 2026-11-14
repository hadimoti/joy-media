import type { ProjectCatalogEntry } from './project-catalog.js';

/** What a project card in the library shows (T-D07), worked out from a catalog entry. */
export interface ProjectCardView {
  /** "9:16", or "1000×777" when the size has no short ratio. Undefined while unknown. */
  readonly format: string | undefined;
  /** The shape of the placeholder frame and the cover, width / height. */
  readonly aspect: number;
  /** "0:24" or "1:02:03". Undefined while unknown. */
  readonly duration: string | undefined;
  /** "edited 2 h ago". */
  readonly edited: string;
  /** A valid `data:image/…` cover, or undefined to show the placeholder. */
  readonly coverUrl: string | undefined;
  /** "9:16 · 0:24 · edited 2 h ago": the known parts only. */
  readonly meta: string;
}

/** The aspect used by the placeholder when the project has no recorded size (a 16:9 frame). */
const UNKNOWN_ASPECT = 16 / 9;
/** A reduced ratio is shown as "w:h" only while both sides stay this small. */
const MAX_RATIO_SIDE = 32;
/** A cover must be a small data URL: the catalog lives in browser storage, which has a quota. */
export const MAX_COVER_DATA_URL_LENGTH = 48 * 1024;

export function projectCardView(
  entry: ProjectCatalogEntry,
  now: Date = new Date(),
  trashed = false,
): ProjectCardView {
  const canvas = validCanvas(entry.canvas);
  const format = canvas === undefined ? undefined : formatLabel(canvas.width, canvas.height);
  const duration = validDuration(entry.durationUs);
  const edited = trashed
    ? `moved to Trash ${relativeTime(entry.trashedAt ?? entry.updatedAt, now)}`
    : `edited ${relativeTime(entry.updatedAt, now)}`;
  return {
    format,
    aspect: canvas === undefined ? UNKNOWN_ASPECT : canvas.width / canvas.height,
    duration: duration === undefined ? undefined : formatDuration(duration),
    edited,
    coverUrl: validCover(entry.coverDataUrl),
    meta: [format, duration === undefined ? undefined : formatDuration(duration), edited]
      .filter((part): part is string => part !== undefined)
      .join(' · '),
  };
}

function validCanvas(
  canvas: ProjectCatalogEntry['canvas'],
): { readonly width: number; readonly height: number } | undefined {
  if (canvas === undefined) return undefined;
  const { width, height } = canvas;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    return undefined;
  return { width, height };
}

function validDuration(durationUs: number | undefined): number | undefined {
  if (durationUs === undefined || !Number.isFinite(durationUs) || durationUs < 0) return undefined;
  return durationUs;
}

function validCover(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  if (url.length > MAX_COVER_DATA_URL_LENGTH) return undefined;
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(url) ? url : undefined;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** "9:16" for 1080×1920; the size itself when the reduced ratio is not short. */
export function formatLabel(width: number, height: number): string {
  if (Number.isInteger(width) && Number.isInteger(height)) {
    const divisor = gcd(width, height);
    const w = width / divisor;
    const h = height / divisor;
    if (w <= MAX_RATIO_SIDE && h <= MAX_RATIO_SIDE) return `${w}:${h}`;
  }
  return `${Math.round(width)}×${Math.round(height)}`;
}

/** "0:24", "2:05", "1:02:03". Rounds to the nearest second, never shows less than 0:00. */
export function formatDuration(durationUs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationUs / 1_000_000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const two = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "just now", "5 min ago", "2 h ago", "3 d ago"; a date after 30 days. */
export function relativeTime(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'at an unknown time';
  const elapsed = now.getTime() - then.getTime();
  // A clock that moved back must not print a negative age.
  if (elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  if (elapsed < 30 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)} d ago`;
  return `on ${then.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
}
