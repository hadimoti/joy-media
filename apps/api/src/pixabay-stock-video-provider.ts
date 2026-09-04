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

export interface PixabayStockVideoProviderOptions {
  readonly apiKey: string;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

export class PixabayStockVideoProvider implements StockVideoProvider {
  readonly id = 'pixabay' as const;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: PixabayStockVideoProviderOptions) {
    if (!options.apiKey.trim()) throw new TypeError('Pixabay API key is required');
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async search(
    request: StockVideoSearchRequest,
    signal?: AbortSignal,
  ): Promise<readonly StockVideoCandidate[]> {
    const url = new URL('https://pixabay.com/api/videos/');
    url.searchParams.set('key', this.#apiKey);
    url.searchParams.set('q', request.query ?? '');
    url.searchParams.set('per_page', String(Math.min(request.perPage ?? 30, 200)));
    url.searchParams.set('page', String(Math.max(request.page ?? 1, 1)));
    const response = await this.#request(url, {}, signal);
    if (!response.ok)
      throw new StockVideoProviderError(
        providerErrorCode(response.status),
        'Pixabay search is unavailable',
      );
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.hits))
      throw new StockVideoProviderError('INVALID_RESPONSE', 'Pixabay response is invalid');
    return dedupeCandidates(body.hits.flatMap((hit) => this.#normalize(hit, request.category)));
  }

  fetchPoster(url: string, signal?: AbortSignal): Promise<Response> {
    assertProviderUrl('pixabay', url);
    return this.#request(url, {}, signal, true);
  }
  fetchPreview(url: string, signal?: AbortSignal, range?: string): Promise<Response> {
    assertProviderUrl('pixabay', url);
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
          assertProviderUrl('pixabay', redirected.toString());
        } catch {
          return new Response(null, { status: 502 });
        }
        current = redirected.toString();
      }
      return new Response(null, { status: 508 });
    } catch {
      throw new StockVideoProviderError('UNAVAILABLE', 'Pixabay is unavailable');
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
    const videos = isRecord(value.videos) ? value.videos : {};
    const files = Object.entries(videos)
      .filter(([, file]) => isRecord(file))
      .map(([, file]) => file as Record<string, unknown>);
    const rendition = selectRendition(files);
    const mediaUrl = rendition ? stringValue(rendition.url ?? rendition.link) : '';
    const sourcePageUrl = stringValue(value.pageURL);
    const posterId = stringValue(value.picture_id);
    // Pixabay currently returns the poster alongside each video rendition.
    // Keep the legacy picture_id fallback for older responses, but prefer the
    // rendition thumbnail so current API hits are not discarded as incomplete.
    const posterUrl =
      stringValue(rendition?.thumbnail) ||
      (posterId ? `https://i.vimeocdn.com/video/${posterId}_640x360.jpg` : '');
    const creator = stringValue(value.user);
    const width = numberValue(rendition?.width);
    const height = numberValue(rendition?.height);
    const duration = numberValue(value.duration);
    if (
      !rendition ||
      !mediaUrl ||
      !sourcePageUrl ||
      !posterUrl ||
      !creator ||
      width < 1 ||
      height < 1 ||
      duration < 1
    )
      return [];
    try {
      assertProviderUrl('pixabay', mediaUrl);
      assertProviderUrl('pixabay', posterUrl);
    } catch {
      return [];
    }
    return [
      {
        provider: 'pixabay',
        providerAssetId: String(value.id),
        ...(requestCategoryHint === undefined ? {} : { category: requestCategoryHint }),
        title: `Pixabay video ${value.id}`,
        creator,
        sourcePageUrl,
        termsUrl: 'https://pixabay.com/service/license-summary/',
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
