import {
  assertProviderUrl,
  dedupeCandidates,
  providerErrorCode,
  selectRendition,
  StockVideoProviderError,
  type StockVideoCandidate,
  type StockVideoProvider,
  type StockVideoSearchRequest,
} from './stock-video-providers.js';

export interface PexelsStockVideoProviderOptions {
  readonly apiKey: string;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

export class PexelsStockVideoProvider implements StockVideoProvider {
  readonly id = 'pexels' as const;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: PexelsStockVideoProviderOptions) {
    if (!options.apiKey.trim()) throw new TypeError('Pexels API key is required');
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async search(
    request: StockVideoSearchRequest,
    signal?: AbortSignal,
  ): Promise<readonly StockVideoCandidate[]> {
    const url = new URL('https://api.pexels.com/videos/search');
    if (request.query) url.searchParams.set('query', request.query);
    url.searchParams.set('per_page', String(Math.min(request.perPage ?? 30, 80)));
    url.searchParams.set('page', String(Math.max(request.page ?? 1, 1)));
    const response = await this.#request(url, { headers: { Authorization: this.#apiKey } }, signal);
    if (!response.ok)
      throw new StockVideoProviderError(
        providerErrorCode(response.status),
        'Pexels search is unavailable',
      );
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.videos))
      throw new StockVideoProviderError('INVALID_RESPONSE', 'Pexels response is invalid');
    const candidates = body.videos.flatMap((video) => this.#normalize(video, request.category));
    return dedupeCandidates(candidates);
  }

  fetchPoster(url: string, signal?: AbortSignal): Promise<Response> {
    assertProviderUrl('pexels', url);
    return this.#request(url, {}, signal, true);
  }

  fetchPreview(url: string, signal?: AbortSignal, range?: string): Promise<Response> {
    assertProviderUrl('pexels', url);
    return this.#request(url, range ? { headers: { Range: range } } : {}, signal, true);
  }

  async #request(
    input: string | URL,
    init: RequestInit,
    signal?: AbortSignal,
    revalidateRedirects = false,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      let current: string | URL = input;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await this.#fetch(current, {
          ...init,
          redirect: 'manual',
          signal: controller.signal,
        });
        if (!revalidateRedirects || response.status < 300 || response.status >= 400)
          return response;
        const location = response.headers.get('location');
        if (!location) return new Response(null, { status: 502 });
        let redirected: URL;
        try {
          redirected = new URL(location, current.toString());
          assertProviderUrl('pexels', redirected.toString());
        } catch {
          return new Response(null, { status: 502 });
        }
        current = redirected.toString();
      }
      return new Response(null, { status: 508 });
    } catch {
      throw new StockVideoProviderError('UNAVAILABLE', 'Pexels is unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  #normalize(
    value: unknown,
    requestCategoryHint?: StockVideoSearchRequest['category'],
  ): StockVideoCandidate[] {
    if (!isRecord(value) || (typeof value.id !== 'number' && typeof value.id !== 'string'))
      return [];
    const files = Array.isArray(value.video_files) ? value.video_files.filter(isRecord) : [];
    const rendition = selectRendition(files);
    if (!rendition) return [];
    const mediaUrl = stringValue(rendition.link ?? rendition.url);
    const posterUrl = stringValue(value.image);
    const sourcePageUrl = stringValue(value.url);
    const creator = isRecord(value.user) ? stringValue(value.user.name) : '';
    const width = numberValue(rendition.width);
    const height = numberValue(rendition.height);
    const duration = numberValue(value.duration);
    if (
      !mediaUrl ||
      !posterUrl ||
      !sourcePageUrl ||
      !creator ||
      width < 1 ||
      height < 1 ||
      duration < 1
    )
      return [];
    try {
      assertProviderUrl('pexels', mediaUrl);
      assertProviderUrl('pexels', posterUrl);
    } catch {
      return [];
    }
    return [
      {
        provider: 'pexels',
        providerAssetId: String(value.id),
        ...(requestCategoryHint === undefined ? {} : { category: requestCategoryHint }),
        title: stringValue(value.title) || `Pexels video ${value.id}`,
        creator,
        sourcePageUrl,
        termsUrl: 'https://www.pexels.com/license/',
        renditionId: String(rendition.id ?? `${width}x${height}`),
        mediaUrl,
        posterUrl,
        mimeType: 'video/mp4',
        width,
        height,
        durationSeconds: duration,
        ...(numberValue(rendition.size) > 0 ? { bytes: numberValue(rendition.size) } : {}),
        orientation: width >= height ? 'landscape' : 'portrait',
      },
    ];
  }
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
