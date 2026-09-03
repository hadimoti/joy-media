import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import {
  ControlPlaneError,
  type Actor,
  type AssetRegistration,
  type ControlPlane,
} from './control-plane.js';
import type { PrivateObjectStore } from './private-object-store.js';
import {
  cacheKey,
  candidateKey,
  dedupeCandidates,
  normalizeSearchQuery,
  type StockVideoCategory,
  type StockVideoCandidate,
  type StockVideoOrientation,
  type StockVideoProvider,
  type StockVideoSearchRequest,
} from './stock-video-providers.js';

export const STOCK_VIDEO_RENDITION_MAX_BYTES = 60 * 1024 * 1024;
export const STOCK_VIDEO_POSTER_MAX_BYTES = 5 * 1024 * 1024;

const CATEGORY_SEARCH_TERMS: Readonly<Record<StockVideoCategory, string>> = {
  'business-work': 'business office teamwork professional',
  technology: 'technology computer digital coding',
  'people-lifestyle': 'people lifestyle everyday life',
  nature: 'nature landscape outdoors',
  'travel-places': 'travel landmarks destination',
  'city-transport': 'city street transport traffic',
  'food-drink': 'food cooking drink',
  'abstract-backgrounds': 'abstract background motion texture',
};

export type StockVideoCatalogRecord = Omit<StockVideoCandidate, 'category'> & {
  readonly category: StockVideoCategory;
  readonly catalogId: string;
  readonly retrievedAt: number;
  readonly expiresAt?: number;
};
export interface BrowserStockVideo {
  readonly id: string;
  readonly title: string;
  readonly provider: StockVideoCandidate['provider'];
  readonly creator: string;
  readonly sourcePageUrl: string;
  readonly termsUrl: string;
  readonly renditionId: string;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  readonly orientation: StockVideoOrientation;
}
export type StockVideoImportState =
  'claimed' | 'downloading' | 'object-stored' | 'registered' | 'completed' | 'failed';
export interface StockVideoImportRecord {
  readonly importId: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly catalogId: string;
  readonly provider: StockVideoCandidate['provider'];
  readonly providerAssetId: string;
  readonly renditionId: string;
  readonly state: StockVideoImportState;
  readonly assetId?: string;
  readonly objectSha256?: string;
  readonly objectBytes?: number;
  readonly errorCode?: string;
  readonly updatedAt: number;
  readonly createdAt?: number;
}
export interface StockVideoSearchResult {
  readonly items: readonly BrowserStockVideo[];
  readonly count: number;
  readonly nextCursor?: string;
}
export interface StockVideoCacheRecord {
  readonly key: string;
  readonly candidates: readonly StockVideoCatalogRecord[];
  readonly expiresAt: number;
  readonly fetchedAt: number;
}
export interface MediaAssetSourceRecord {
  readonly assetId: string;
  readonly provider: StockVideoCandidate['provider'];
  readonly providerAssetId: string;
  readonly creator: string;
  readonly sourcePageUrl: string;
  readonly termsUrl: string;
  readonly retrievedAt: number;
  readonly renditionId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
}
export interface StockVideoRepository {
  findCatalog(id: string): Promise<StockVideoCatalogRecord | undefined>;
  listCatalog(request: StockVideoSearchRequest): Promise<readonly StockVideoCatalogRecord[]>;
  saveCatalog(records: readonly StockVideoCatalogRecord[]): Promise<void>;
  getCache(key: string): Promise<StockVideoCacheRecord | undefined>;
  saveCache(record: StockVideoCacheRecord): Promise<void>;
  findImport(
    ownerId: string,
    providerOrProjectId: string,
    providerOrAssetId: string,
    assetOrRenditionId: string,
    renditionId?: string,
  ): Promise<StockVideoImportRecord | undefined>;
  findImportById(importId: string): Promise<StockVideoImportRecord | undefined>;
  createImport(record: StockVideoImportRecord): Promise<StockVideoImportRecord>;
  updateImport(
    importId: string,
    patch: Partial<StockVideoImportRecord>,
  ): Promise<StockVideoImportRecord>;
  saveSource(record: MediaAssetSourceRecord): Promise<void>;
}

export class MemoryStockVideoRepository implements StockVideoRepository {
  readonly #catalog = new Map<string, StockVideoCatalogRecord>();
  readonly #cache = new Map<string, StockVideoCacheRecord>();
  readonly #imports = new Map<string, StockVideoImportRecord>();
  readonly #sources = new Map<string, MediaAssetSourceRecord>();
  async findCatalog(id: string) {
    return this.#catalog.get(id);
  }
  async listCatalog(request: StockVideoSearchRequest) {
    const query = normalizeSearchQuery(request.query).toLocaleLowerCase();
    return [...this.#catalog.values()]
      .filter(
        (item) =>
          (!request.category || item.category === request.category) &&
          (!query || `${item.title} ${item.creator}`.toLocaleLowerCase().includes(query)),
      )
      .slice(0, 6);
  }
  async saveCatalog(records: readonly StockVideoCatalogRecord[]) {
    for (const record of records) this.#catalog.set(record.catalogId, record);
  }
  async getCache(key: string) {
    return this.#cache.get(key);
  }
  async saveCache(record: StockVideoCacheRecord) {
    this.#cache.set(record.key, record);
  }
  async findImport(
    ownerId: string,
    providerOrProjectId: string,
    providerOrAssetId: string,
    assetOrRenditionId: string,
    renditionId?: string,
  ) {
    const provider = renditionId === undefined ? providerOrProjectId : providerOrAssetId;
    const providerAssetId = renditionId === undefined ? providerOrAssetId : assetOrRenditionId;
    const selectedRenditionId = renditionId === undefined ? assetOrRenditionId : renditionId;
    return [...this.#imports.values()].find(
      (item) =>
        item.ownerId === ownerId &&
        item.provider === provider &&
        item.providerAssetId === providerAssetId &&
        item.renditionId === selectedRenditionId,
    );
  }
  async findImportById(importId: string) {
    return this.#imports.get(importId);
  }
  async createImport(record: StockVideoImportRecord) {
    const prior = await this.findImport(
      record.ownerId,
      record.provider,
      record.providerAssetId,
      record.renditionId,
    );
    if (prior) return prior;
    this.#imports.set(record.importId, record);
    return record;
  }
  async updateImport(importId: string, patch: Partial<StockVideoImportRecord>) {
    const current = this.#imports.get(importId);
    if (!current) throw new ControlPlaneError('STOCK_IMPORT_NOT_FOUND', importId);
    const updated = { ...current, ...patch, updatedAt: Date.now() };
    this.#imports.set(importId, updated);
    return updated;
  }
  async saveSource(record: MediaAssetSourceRecord) {
    this.#sources.set(record.assetId, record);
  }
}

export interface StockVideoServiceOptions {
  readonly repository: StockVideoRepository;
  readonly providers: readonly StockVideoProvider[];
  readonly controlPlane: ControlPlane;
  readonly privateObjectStore: PrivateObjectStore;
  readonly stagingDirectory?: string;
  readonly now?: () => number;
}

export class StockVideoService {
  readonly #repository: StockVideoRepository;
  readonly #providers: readonly StockVideoProvider[];
  readonly #controlPlane: ControlPlane;
  readonly #store: PrivateObjectStore;
  readonly #stagingDirectory: string;
  readonly #now: () => number;
  readonly #running = new Set<string>();
  readonly #searches = new Map<string, Promise<StockVideoSearchResult>>();
  constructor(options: StockVideoServiceOptions) {
    this.#repository = options.repository;
    this.#providers = options.providers;
    this.#controlPlane = options.controlPlane;
    this.#store = options.privateObjectStore;
    this.#stagingDirectory = options.stagingDirectory ?? '/opt/joy-media/data/stock-video-staging';
    this.#now = options.now ?? Date.now;
  }
  async search(request: StockVideoSearchRequest): Promise<StockVideoSearchResult> {
    const effectiveRequest = this.#effectiveRequest(request);
    const key = cacheKey(effectiveRequest);
    const inFlight = this.#searches.get(key);
    if (inFlight !== undefined) return inFlight;
    const operation = this.#searchUncached(effectiveRequest, key);
    this.#searches.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.#searches.get(key) === operation) this.#searches.delete(key);
    }
  }
  #effectiveRequest(request: StockVideoSearchRequest): StockVideoSearchRequest {
    const query = normalizeSearchQuery(request.query);
    if (query.length > 0) return { ...request, query };
    if (request.category === undefined) return request;
    return { ...request, query: CATEGORY_SEARCH_TERMS[request.category] };
  }
  async #searchUncached(
    request: StockVideoSearchRequest,
    key: string,
  ): Promise<StockVideoSearchResult> {
    const cached = await this.#repository.getCache(key);
    const now = this.#now();
    if (cached && cached.expiresAt > now) return this.#result(cached.candidates);
    const all: StockVideoCandidate[] = [];
    for (const provider of this.#providers) {
      try {
        all.push(...(await provider.search(request)));
      } catch {
        /* preserve healthy provider/cache results */
      }
    }
    const unique = dedupeCandidates(all)
      .slice(0, 6)
      .map((candidate) => ({
        ...candidate,
        category: candidate.category ?? request.category ?? 'business-work',
        catalogId: `stock-${candidateKey(candidate).replace(/[^A-Za-z0-9._-]/g, '-')}`,
        retrievedAt: now,
      }));
    if (unique.length > 0) {
      await this.#repository.saveCatalog(unique);
      await this.#repository.saveCache({
        key,
        candidates: unique,
        fetchedAt: now,
        expiresAt:
          now +
          (this.#providers.length === 1 && this.#providers[0]?.id === 'pixabay'
            ? 86_400_000
            : 3_600_000),
      });
    }
    const persisted = unique.length > 0 ? unique : await this.#repository.listCatalog(request);
    return this.#result(persisted);
  }
  async getCatalog(id: string): Promise<StockVideoCatalogRecord> {
    const record = await this.#repository.findCatalog(id);
    if (!record) throw new ControlPlaneError('STOCK_VIDEO_NOT_FOUND', id);
    return record;
  }
  async browserCatalog(id: string): Promise<BrowserStockVideo> {
    return browserStockVideo(await this.getCatalog(id));
  }
  async proxy(
    id: string,
    kind: 'poster' | 'preview',
    range?: string,
  ): Promise<{
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly status: number;
    readonly contentRange?: string;
  }> {
    const record = await this.getCatalog(id);
    const provider = this.#providers.find((item) => item.id === record.provider);
    if (!provider) throw new ControlPlaneError('STOCK_PROVIDER_UNAVAILABLE', record.provider);
    const boundedRange = kind === 'preview' ? boundedPreviewRange(range) : undefined;
    const response =
      kind === 'poster'
        ? await provider.fetchPoster(record.posterUrl)
        : await provider.fetchPreview(record.mediaUrl, undefined, boundedRange);
    if (!response.ok && response.status !== 206)
      throw new ControlPlaneError('STOCK_PROVIDER_UNAVAILABLE', 'stock media is unavailable');
    const bytes = await boundedResponseBytes(
      response,
      kind === 'poster' ? STOCK_VIDEO_POSTER_MAX_BYTES : STOCK_VIDEO_RENDITION_MAX_BYTES,
    );
    const mimeType = kind === 'poster' ? 'image/jpeg' : 'video/mp4';
    return {
      bytes,
      mimeType,
      status: response.status === 206 ? 206 : 200,
      ...(response.headers.get('content-range')
        ? { contentRange: response.headers.get('content-range')! }
        : {}),
    };
  }
  async startImport(
    actor: Actor,
    projectId: string,
    catalogId: string,
  ): Promise<StockVideoImportRecord> {
    const catalog = await this.getCatalog(catalogId);
    const existing = await this.#repository.findImport(
      actor.id,
      catalog.provider,
      catalog.providerAssetId,
      catalog.renditionId,
    );
    if (existing) {
      if (
        !this.#running.has(existing.importId) &&
        (existing.state === 'claimed' || existing.state === 'downloading')
      )
        void this.#runImport(existing.importId);
      return existing;
    }
    const created = await this.#repository.createImport({
      importId: `import-${randomUUID()}`,
      ownerId: actor.id,
      projectId,
      catalogId,
      provider: catalog.provider,
      providerAssetId: catalog.providerAssetId,
      renditionId: catalog.renditionId,
      state: 'claimed',
      updatedAt: this.#now(),
    });
    if (!this.#running.has(created.importId)) void this.#runImport(created.importId);
    return created;
  }
  async importStatus(
    actor: Actor,
    projectId: string,
    importId: string,
  ): Promise<StockVideoImportRecord> {
    const result = await this.#repository.findImportById(importId);
    if (result === undefined || result.ownerId !== actor.id || result.projectId !== projectId)
      throw new ControlPlaneError('STOCK_IMPORT_NOT_FOUND', importId);
    return result;
  }
  async #runImport(importId: string): Promise<void> {
    if (this.#running.has(importId)) return;
    this.#running.add(importId);
    let temporary: string | undefined;
    let storedRef: string | undefined;
    let registered = false;
    try {
      const current = await this.#repository.updateImport(importId, { state: 'downloading' });
      const catalog = await this.getCatalog(current.catalogId);
      const provider = this.#providers.find((item) => item.id === catalog.provider);
      if (!provider) throw new Error('provider unavailable');
      const response = await provider.fetchPreview(catalog.mediaUrl);
      if (!response.ok) throw new Error('provider media unavailable');
      const bytes = await boundedResponseBytes(response, STOCK_VIDEO_RENDITION_MAX_BYTES);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      temporary = join(this.#stagingDirectory, `${importId}.mp4`);
      await mkdir(this.#stagingDirectory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, bytes, { mode: 0o600 });
      const ref = `stock-${sha256}`;
      storedRef = ref;
      await this.#store.put({ ref, sha256, bytes: bytes.byteLength, mimeType: 'video/mp4' }, bytes);
      await this.#repository.updateImport(importId, {
        state: 'object-stored',
        objectSha256: sha256,
        objectBytes: bytes.byteLength,
      });
      const assetId = `asset-${randomUUID()}`;
      const registration: AssetRegistration = {
        id: assetId,
        kind: 'video',
        displayName: catalog.title.slice(0, 255),
        sha256,
        bytes: bytes.byteLength,
        descriptor: {
          mimeType: 'video/mp4',
          width: catalog.width,
          height: catalog.height,
          durationUs: Math.round(catalog.durationSeconds * 1_000_000),
        },
        locations: [{ kind: 'opfs-cache', ref: `stock-import-${importId}` }],
      };
      await this.#controlPlane.registerAsset(
        { id: current.ownerId },
        current.projectId,
        registration,
      );
      registered = true;
      await this.#repository.updateImport(importId, { state: 'registered', assetId });
      await this.#controlPlane.attachCloudOriginal(
        { id: current.ownerId },
        current.projectId,
        assetId,
        { kind: 'private-object', ref },
      );
      await this.#repository.saveSource({
        assetId,
        provider: catalog.provider,
        providerAssetId: catalog.providerAssetId,
        creator: catalog.creator,
        sourcePageUrl: catalog.sourcePageUrl,
        termsUrl: catalog.termsUrl,
        retrievedAt: catalog.retrievedAt,
        renditionId: catalog.renditionId,
        sha256,
        bytes: bytes.byteLength,
        width: catalog.width,
        height: catalog.height,
        durationSeconds: catalog.durationSeconds,
      });
      await this.#repository.updateImport(importId, { state: 'completed' });
      await rm(temporary, { force: true });
    } catch (error) {
      if (temporary !== undefined) await rm(temporary, { force: true }).catch(() => undefined);
      if (storedRef !== undefined && !registered)
        await this.#store.remove(storedRef).catch(() => undefined);
      await this.#repository
        .updateImport(importId, {
          state: 'failed',
          errorCode: error instanceof ControlPlaneError ? error.code : 'STOCK_IMPORT_FAILED',
        })
        .catch(() => undefined);
    } finally {
      this.#running.delete(importId);
    }
  }
  #result(records: readonly StockVideoCatalogRecord[]): StockVideoSearchResult {
    return {
      items: records.slice(0, 6).map(browserStockVideo),
      count: records.length,
      ...(records.length > 6 ? { nextCursor: 'more' } : {}),
    };
  }
}

function browserStockVideo(record: StockVideoCatalogRecord): BrowserStockVideo {
  return {
    id: record.catalogId,
    title: record.title,
    provider: record.provider,
    creator: record.creator,
    sourcePageUrl: record.sourcePageUrl,
    termsUrl: record.termsUrl,
    renditionId: record.renditionId,
    width: record.width,
    height: record.height,
    durationSeconds: record.durationSeconds,
    orientation: record.orientation,
  };
}
async function boundedResponseBytes(response: Response, limit: number): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > limit)
    throw new ControlPlaneError('STOCK_MEDIA_TOO_LARGE', 'stock media exceeds the limit');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limit)
    throw new ControlPlaneError('STOCK_MEDIA_TOO_LARGE', 'stock media exceeds the limit');
  return bytes;
}
function boundedPreviewRange(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/i.exec(value.trim());
  if (match === null)
    throw new ControlPlaneError('STOCK_REQUEST_INVALID', 'stock video range is invalid');
  const start = Number(match[1]);
  const end = match[2] === '' ? undefined : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    (end !== undefined && (!Number.isSafeInteger(end) || end < start)) ||
    (end !== undefined && end - start + 1 > STOCK_VIDEO_RENDITION_MAX_BYTES) ||
    start >= STOCK_VIDEO_RENDITION_MAX_BYTES
  )
    throw new ControlPlaneError('STOCK_REQUEST_INVALID', 'stock video range is invalid');
  return `bytes=${start}-${end === undefined ? '' : end}`;
}

export class PostgresStockVideoRepository implements StockVideoRepository {
  constructor(private readonly pool: Pool) {}
  async findCatalog(id: string) {
    const result = await this.pool.query<StockCatalogRow>(
      'SELECT * FROM stock_video_catalog WHERE id = $1',
      [id],
    );
    return result.rows[0] ? catalogOf(result.rows[0]) : undefined;
  }
  async listCatalog(request: StockVideoSearchRequest) {
    const result = await this.pool.query<StockCatalogRow>(
      "SELECT * FROM stock_video_catalog WHERE ($1::text IS NULL OR category = $1) AND ($2 = '' OR title ILIKE '%' || $2 || '%' OR creator ILIKE '%' || $2 || '%') ORDER BY retrieved_at DESC, id LIMIT 6",
      [request.category ?? null, normalizeSearchQuery(request.query)],
    );
    return result.rows.map(catalogOf);
  }
  async saveCatalog(records: readonly StockVideoCatalogRecord[]) {
    for (const item of records)
      await this.pool.query(
        `INSERT INTO stock_video_catalog (id,provider,provider_asset_id,category,title,creator,source_page_url,terms_url,rendition_id,media_url,poster_url,mime_type,width,height,duration_seconds,orientation,retrieved_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (provider,provider_asset_id,rendition_id) DO UPDATE SET id=EXCLUDED.id,category=EXCLUDED.category,title=EXCLUDED.title,creator=EXCLUDED.creator,source_page_url=EXCLUDED.source_page_url,terms_url=EXCLUDED.terms_url,media_url=EXCLUDED.media_url,poster_url=EXCLUDED.poster_url,retrieved_at=EXCLUDED.retrieved_at,expires_at=EXCLUDED.expires_at`,
        [
          item.catalogId,
          item.provider,
          item.providerAssetId,
          item.category,
          item.title,
          item.creator,
          item.sourcePageUrl,
          item.termsUrl,
          item.renditionId,
          item.mediaUrl,
          item.posterUrl,
          item.mimeType,
          item.width,
          item.height,
          item.durationSeconds,
          item.orientation,
          new Date(item.retrievedAt),
          item.expiresAt ? new Date(item.expiresAt) : null,
        ],
      );
  }
  async getCache(key: string) {
    const result = await this.pool.query<{
      cache_key: string;
      candidates: unknown;
      fetched_at: Date;
      expires_at: Date;
    }>('SELECT * FROM stock_video_search_cache WHERE cache_key = $1', [key]);
    const row = result.rows[0];
    return row
      ? {
          key: row.cache_key,
          candidates: row.candidates as StockVideoCatalogRecord[],
          fetchedAt: row.fetched_at.getTime(),
          expiresAt: row.expires_at.getTime(),
        }
      : undefined;
  }
  async saveCache(record: StockVideoCacheRecord) {
    await this.pool.query(
      'INSERT INTO stock_video_search_cache (cache_key,response_version,candidates,fetched_at,expires_at) VALUES ($1,1,$2::jsonb,$3,$4) ON CONFLICT (cache_key) DO UPDATE SET candidates=EXCLUDED.candidates,fetched_at=EXCLUDED.fetched_at,expires_at=EXCLUDED.expires_at',
      [
        record.key,
        JSON.stringify(record.candidates),
        new Date(record.fetchedAt),
        new Date(record.expiresAt),
      ],
    );
  }
  async findImport(
    ownerId: string,
    providerOrProjectId: string,
    providerOrAssetId: string,
    assetOrRenditionId: string,
    renditionId?: string,
  ) {
    const provider = renditionId === undefined ? providerOrProjectId : providerOrAssetId;
    const providerAssetId = renditionId === undefined ? providerOrAssetId : assetOrRenditionId;
    const selectedRenditionId = renditionId === undefined ? assetOrRenditionId : renditionId;
    const result = await this.pool.query<StockImportRow>(
      'SELECT * FROM stock_video_imports WHERE owner_id=$1 AND provider=$2 AND provider_asset_id=$3 AND rendition_id=$4',
      [ownerId, provider, providerAssetId, selectedRenditionId],
    );
    return result.rows[0] ? importOf(result.rows[0]) : undefined;
  }
  async findImportById(importId: string) {
    const result = await this.pool.query<StockImportRow>(
      'SELECT * FROM stock_video_imports WHERE id=$1',
      [importId],
    );
    return result.rows[0] ? importOf(result.rows[0]) : undefined;
  }
  async createImport(record: StockVideoImportRecord) {
    const result = await this.pool.query<StockImportRow>(
      'INSERT INTO stock_video_imports (id,owner_id,project_id,catalog_id,provider,provider_asset_id,rendition_id,state,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (owner_id,provider,provider_asset_id,rendition_id) DO UPDATE SET updated_at=stock_video_imports.updated_at RETURNING *',
      [
        record.importId,
        record.ownerId,
        record.projectId,
        record.catalogId,
        record.provider,
        record.providerAssetId,
        record.renditionId,
        record.state,
        new Date(record.updatedAt),
      ],
    );
    return importOf(result.rows[0]!);
  }
  async updateImport(importId: string, patch: Partial<StockVideoImportRecord>) {
    const current = await this.pool.query<StockImportRow>(
      'SELECT * FROM stock_video_imports WHERE id=$1',
      [importId],
    );
    if (!current.rows[0]) throw new ControlPlaneError('STOCK_IMPORT_NOT_FOUND', importId);
    const keys: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined && key !== 'importId') {
        keys.push(`${snake(key)}=$${values.length + 2}`);
        values.push(key.endsWith('At') ? new Date(value as number) : value);
      }
    }
    keys.push(`updated_at=$${values.length + 2}`);
    values.push(new Date());
    const result = await this.pool.query<StockImportRow>(
      `UPDATE stock_video_imports SET ${keys.join(',')} WHERE id=$1 RETURNING *`,
      [importId, ...values],
    );
    return importOf(result.rows[0]!);
  }
  async saveSource(record: MediaAssetSourceRecord) {
    await this.pool.query(
      'INSERT INTO media_asset_sources (asset_id,provider,provider_asset_id,creator,source_page_url,terms_url,retrieved_at,rendition_id,sha256,bytes,width,height,duration_seconds) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (asset_id) DO UPDATE SET sha256=EXCLUDED.sha256',
      [
        record.assetId,
        record.provider,
        record.providerAssetId,
        record.creator,
        record.sourcePageUrl,
        record.termsUrl,
        new Date(record.retrievedAt),
        record.renditionId,
        record.sha256,
        record.bytes,
        record.width,
        record.height,
        record.durationSeconds,
      ],
    );
  }
}
interface StockCatalogRow {
  readonly id: string;
  readonly provider: StockVideoCandidate['provider'];
  readonly provider_asset_id: string;
  readonly category: StockVideoCatalogRecord['category'];
  readonly title: string;
  readonly creator: string;
  readonly source_page_url: string;
  readonly terms_url: string;
  readonly rendition_id: string;
  readonly media_url: string;
  readonly poster_url: string;
  readonly mime_type: string;
  readonly width: number;
  readonly height: number;
  readonly duration_seconds: number | string;
  readonly orientation: StockVideoOrientation;
  readonly retrieved_at: Date | string | number;
  readonly expires_at: Date | string | number | null;
}
interface StockImportRow {
  readonly id: string;
  readonly owner_id: string;
  readonly project_id: string;
  readonly catalog_id: string;
  readonly provider: StockVideoCandidate['provider'];
  readonly provider_asset_id: string;
  readonly rendition_id: string;
  readonly state: StockVideoImportState;
  readonly asset_id: string | null;
  readonly object_sha256: string | null;
  readonly object_bytes: number | string | null;
  readonly error_code: string | null;
  readonly updated_at: Date | string | number;
}
function catalogOf(row: StockCatalogRow): StockVideoCatalogRecord {
  return {
    catalogId: row.id,
    provider: row.provider,
    providerAssetId: row.provider_asset_id,
    category: row.category,
    title: row.title,
    creator: row.creator,
    sourcePageUrl: row.source_page_url,
    termsUrl: row.terms_url,
    renditionId: row.rendition_id,
    mediaUrl: row.media_url,
    posterUrl: row.poster_url,
    mimeType: 'video/mp4',
    width: row.width,
    height: row.height,
    durationSeconds: Number(row.duration_seconds),
    orientation: row.orientation,
    retrievedAt: new Date(row.retrieved_at).getTime(),
    ...(row.expires_at ? { expiresAt: new Date(row.expires_at).getTime() } : {}),
  };
}
function importOf(row: StockImportRow): StockVideoImportRecord {
  return {
    importId: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    catalogId: row.catalog_id,
    provider: row.provider,
    providerAssetId: row.provider_asset_id,
    renditionId: row.rendition_id,
    state: row.state,
    ...(row.asset_id ? { assetId: row.asset_id } : {}),
    ...(row.object_sha256 ? { objectSha256: row.object_sha256 } : {}),
    ...(row.object_bytes === null ? {} : { objectBytes: Number(row.object_bytes) }),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    updatedAt: new Date(row.updated_at).getTime(),
  };
}
function snake(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}
