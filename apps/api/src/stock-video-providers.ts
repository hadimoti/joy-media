import { createHash } from 'node:crypto';

export const STOCK_VIDEO_CATEGORIES = [
  'business-work',
  'technology',
  'people-lifestyle',
  'nature',
  'travel-places',
  'city-transport',
  'food-drink',
  'abstract-backgrounds',
] as const;
export type StockVideoCategory = (typeof STOCK_VIDEO_CATEGORIES)[number];
export type StockVideoOrientation = 'portrait' | 'landscape';

export interface StockVideoSearchRequest {
  readonly query?: string;
  readonly category?: StockVideoCategory;
  readonly page?: number;
  readonly perPage?: number;
}

export interface StockVideoCandidate {
  readonly provider: 'pexels' | 'pixabay';
  readonly providerAssetId: string;
  readonly category?: StockVideoCategory;
  readonly title: string;
  readonly creator: string;
  readonly sourcePageUrl: string;
  readonly termsUrl: string;
  readonly renditionId: string;
  readonly mediaUrl: string;
  readonly posterUrl: string;
  readonly mimeType: 'video/mp4';
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  readonly bytes?: number;
  readonly orientation: StockVideoOrientation;
}

export interface StockVideoProvider {
  readonly id: StockVideoCandidate['provider'];
  search(
    request: StockVideoSearchRequest,
    signal?: AbortSignal,
  ): Promise<readonly StockVideoCandidate[]>;
  fetchPoster(url: string, signal?: AbortSignal): Promise<Response>;
  fetchPreview(url: string, signal?: AbortSignal, range?: string): Promise<Response>;
}

export class StockVideoProviderError extends Error {
  constructor(
    readonly code: 'UNAVAILABLE' | 'INVALID_RESPONSE' | 'UNSAFE_URL',
    message: string,
  ) {
    super(message);
    this.name = 'StockVideoProviderError';
  }
}

export const PROVIDER_HOSTS = {
  pexels: new Set(['www.pexels.com', 'images.pexels.com', 'player.vimeo.com', 'videos.pexels.com']),
  pixabay: new Set(['pixabay.com', 'cdn.pixabay.com', 'i.vimeocdn.com']),
} as const;

export function normalizeSearchQuery(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

export function assertProviderUrl(provider: StockVideoCandidate['provider'], value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StockVideoProviderError('UNSAFE_URL', 'provider media URL is invalid');
  }
  if (url.protocol !== 'https:' || !PROVIDER_HOSTS[provider].has(url.hostname.toLowerCase()))
    throw new StockVideoProviderError('UNSAFE_URL', 'provider media URL is not allowlisted');
  if (url.username || url.password)
    throw new StockVideoProviderError('UNSAFE_URL', 'provider URL contains credentials');
  return url;
}

export function eligibleStockVideo(candidate: unknown): boolean {
  if (!isRecord(candidate)) return false;
  const provider = providerValue(candidate);
  const mimeType = typeof candidate.mimeType === 'string' ? candidate.mimeType.toLowerCase() : '';
  const width = numberValue(candidate.width);
  const height = numberValue(candidate.height);
  const durationSeconds =
    typeof candidate.durationSeconds === 'number'
      ? candidate.durationSeconds
      : numberValue(candidate.durationUs) / 1_000_000;
  const bytes = numberValue(candidate.bytes);
  const sourcePageUrl = stringValue(candidate.sourcePageUrl);
  const mediaUrl = stringValue(candidate.mediaUrl ?? candidate.previewUrl);
  const creator = stringValue(candidate.creator);
  if (
    !provider ||
    mimeType !== 'video/mp4' ||
    width < 720 ||
    height < 360 ||
    durationSeconds < 5 ||
    durationSeconds > 20 ||
    (bytes > 0 && bytes > MAX_STOCK_VIDEO_BYTES) ||
    !creator ||
    !mediaUrl ||
    !sourcePageUrl
  )
    return false;
  try {
    const source = new URL(sourcePageUrl);
    if (source.protocol !== 'https:' || !sourceHostAllowed(provider, source.hostname)) return false;
    assertProviderUrl(provider, mediaUrl);
    const posterUrl = stringValue(candidate.posterUrl);
    if (posterUrl) assertProviderUrl(provider, posterUrl);
    return true;
  } catch {
    return false;
  }
}

export function candidateKey(
  candidate: Pick<StockVideoCandidate, 'provider' | 'providerAssetId' | 'renditionId'>,
): string {
  return `${candidate.provider}:${candidate.providerAssetId}:${candidate.renditionId}`;
}

export function cacheKey(request: StockVideoSearchRequest): string {
  const category = request.category ?? '';
  const query = normalizeSearchQuery(request.query).toLocaleLowerCase();
  return createHash('sha256').update(`${category}\0${query}`).digest('hex');
}

export function selectRendition<
  T extends {
    width?: number;
    height?: number;
    link?: string;
    url?: string;
    id?: string;
    file_type?: string;
    size?: number;
  },
>(files: readonly T[]): T | undefined {
  return [...files]
    .filter(
      (file) =>
        (file.file_type ?? 'video/mp4').toLowerCase() === 'video/mp4' &&
        (file.link ?? file.url) !== undefined,
    )
    .sort(
      (left, right) =>
        (right.width ?? 0) * (right.height ?? 0) - (left.width ?? 0) * (left.height ?? 0),
    )[0];
}

export function dedupeCandidates<T>(candidates: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (!eligibleStockVideo(candidate)) return false;
    const value: Record<string, unknown> = isRecord(candidate)
      ? candidate
      : (Object.create(null) as Record<string, unknown>);
    const provider = stringValue(value.provider);
    const providerAssetId = stringValue(value.providerAssetId ?? value.id);
    const renditionId = stringValue(value.renditionId);
    const sha256 = stringValue(value.sha256);
    const key = sha256 ? `sha256:${sha256}` : `${provider}:${providerAssetId}:${renditionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const MAX_STOCK_VIDEO_BYTES = 60 * 1024 * 1024;

export function redactStockVideoDiagnostic(value: string): string {
  return (
    value
      // Upstream response bodies are never safe to echo: they may contain a
      // credential, signed URL, or provider-private diagnostic under an
      // arbitrary field name. Keep only the fact that a body was present.
      .replace(/(\bbody\s*=\s*).*/gis, '$1[redacted]')
      .replace(
        /https?:\/\/[^\s"']+?[?&](?:key|api[_-]?key|token|access_token)=[^\s&"']+/gi,
        '[redacted-url]',
      )
      .replace(
        /(["']?(?:api[_-]?key|access[_-]?token|token|secret|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
        '$1[redacted]',
      )
      .replace(/(\b(?:key|token|secret)=)[^\s&]+/gi, '$1[redacted]')
  );
}

export function providerErrorCode(status: number): StockVideoProviderError['code'] {
  return status === 401 || status === 403 || status === 429 || status >= 500
    ? 'UNAVAILABLE'
    : 'INVALID_RESPONSE';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function providerValue(
  value: Record<string, unknown>,
): StockVideoCandidate['provider'] | undefined {
  if (value.provider === 'pexels' || value.provider === 'pixabay') return value.provider;
  const id = stringValue(value.id).toLowerCase();
  if (id.startsWith('pexels-')) return 'pexels';
  if (id.startsWith('pixabay-')) return 'pixabay';
  return undefined;
}

function sourceHostAllowed(provider: StockVideoCandidate['provider'], hostname: string): boolean {
  const host = hostname.toLowerCase();
  return provider === 'pexels'
    ? host === 'pexels.com' || host.endsWith('.pexels.com')
    : host === 'pixabay.com' || host.endsWith('.pixabay.com');
}
